import {
  AutoFieldSubType,
  AutoReason,
  Datasource,
  FieldSchema,
  FieldType,
  FilterType,
  IncludeRelationship,
  OneToManyRelationshipFieldMetadata,
  Operation,
  PaginationJson,
  RelationshipFieldMetadata,
  RelationshipsJson,
  RelationshipType,
  Row,
  SearchFilters,
  SortJson,
  SortType,
  Table,
} from "@budibase/types"
import {
  breakExternalTableId,
  breakRowIdField,
  convertRowId,
  isRowId,
  isSQL,
} from "../../../integrations/utils"
import {
  buildExternalRelationships,
  buildSqlFieldList,
  generateIdForRow,
  sqlOutputProcessing,
  updateRelationshipColumns,
  fixArrayTypes,
  isManyToMany,
} from "./utils"
import { getDatasourceAndQuery } from "../../../sdk/app/rows/utils"
import { processObjectSync } from "@budibase/string-templates"
import { cloneDeep } from "lodash/fp"
import { db as dbCore } from "@budibase/backend-core"
import { processDates, processFormulas } from "../../../utilities/rowProcessor"
import sdk from "../../../sdk"

export interface ManyRelationship {
  tableId?: string
  id?: string
  isUpdate?: boolean
  key: string
  [key: string]: any
}

export interface RunConfig {
  id?: any[]
  filters?: SearchFilters
  sort?: SortJson
  paginate?: PaginationJson
  datasource?: Datasource
  row?: Row
  rows?: Row[]
  tables?: Record<string, Table>
  includeSqlRelationships?: IncludeRelationship
}

function buildFilters(
  id: string | undefined | string[],
  filters: SearchFilters,
  table: Table
) {
  const primary = table.primary
  // if passed in array need to copy for shifting etc
  let idCopy: undefined | string | any[] = cloneDeep(id)
  if (filters) {
    // need to map over the filters and make sure the _id field isn't present
    let prefix = 1
    for (let operator of Object.values(filters)) {
      for (let field of Object.keys(operator || {})) {
        if (dbCore.removeKeyNumbering(field) === "_id") {
          if (primary) {
            const parts = breakRowIdField(operator[field])
            for (let field of primary) {
              operator[`${prefix}:${field}`] = parts.shift()
            }
            prefix++
          }
          // make sure this field doesn't exist on any filter
          delete operator[field]
        }
      }
    }
  }
  // there is no id, just use the user provided filters
  if (!idCopy || !table) {
    return filters
  }
  // if used as URL parameter it will have been joined
  if (!Array.isArray(idCopy)) {
    idCopy = breakRowIdField(idCopy)
  }
  const equal: any = {}
  if (primary && idCopy) {
    for (let field of primary) {
      // work through the ID and get the parts
      equal[field] = idCopy.shift()
    }
  }
  return {
    equal,
  }
}

/**
 * This function checks the incoming parameters to make sure all the inputs are
 * valid based on on the table schema. The main thing this is looking for is when a
 * user has made use of the _id field of a row for a foreign key or a search parameter.
 * In these cases the key will be sent up as [1], rather than 1. In these cases we will
 * simplify it down to the requirements. This function is quite complex as we try to be
 * relatively restrictive over what types of columns we will perform this action for.
 */
function cleanupConfig(config: RunConfig, table: Table): RunConfig {
  const primaryOptions = [
    FieldType.STRING,
    FieldType.LONGFORM,
    FieldType.OPTIONS,
    FieldType.NUMBER,
  ]
  // filter out fields which cannot be keys
  const fieldNames = Object.entries(table.schema)
    .filter(schema => primaryOptions.find(val => val === schema[1].type))
    // map to fieldName
    .map(entry => entry[0])
  const iterateObject = (obj: { [key: string]: any }) => {
    for (let [field, value] of Object.entries(obj)) {
      if (fieldNames.find(name => name === field) && isRowId(value)) {
        obj[field] = convertRowId(value)
      }
    }
  }
  // check the row and filters to make sure they aren't a key of some sort
  if (config.filters) {
    for (let [key, filter] of Object.entries(config.filters)) {
      // oneOf is an array, don't iterate it
      if (
        typeof filter !== "object" ||
        Object.keys(filter).length === 0 ||
        key === FilterType.ONE_OF
      ) {
        continue
      }
      iterateObject(filter)
    }
  }
  if (config.row) {
    iterateObject(config.row)
  }

  return config
}

function getEndpoint(tableId: string | undefined, operation: string) {
  if (!tableId) {
    return {}
  }
  const { datasourceId, tableName } = breakExternalTableId(tableId)
  return {
    datasourceId,
    entityId: tableName,
    operation,
  }
}

// need to handle table name + field or just field, depending on if relationships used
function extractFieldValue({
  row,
  tableName,
  fieldName,
  isLinked,
}: {
  row: Row
  tableName: string
  fieldName: string
  isLinked: boolean
}) {
  let value = row[`${tableName}.${fieldName}`]
  if (value == null && !isLinked) {
    value = row[fieldName]
  }
  return value
}

function basicProcessing({
  row,
  table,
  isLinked,
}: {
  row: Row
  table: Table
  isLinked: boolean
}): Row {
  const thisRow: Row = {}
  // filter the row down to what is actually the row (not joined)
  for (let field of Object.values(table.schema)) {
    const fieldName = field.name

    const value = extractFieldValue({
      row,
      tableName: table.name,
      fieldName,
      isLinked,
    })

    // all responses include "select col as table.col" so that overlaps are handled
    if (value != null) {
      thisRow[fieldName] = value
    }
  }
  thisRow._id = generateIdForRow(row, table, isLinked)
  thisRow.tableId = table._id
  thisRow._rev = "rev"
  return thisRow
}

function isOneSide(
  field: RelationshipFieldMetadata
): field is OneToManyRelationshipFieldMetadata {
  return (
    field.relationshipType && field.relationshipType.split("-")[0] === "one"
  )
}

function isEditableColumn(column: FieldSchema) {
  const isExternalAutoColumn =
    column.autocolumn &&
    column.autoReason !== AutoReason.FOREIGN_KEY &&
    column.subtype !== AutoFieldSubType.AUTO_ID
  const isFormula = column.type === FieldType.FORMULA
  return !(isExternalAutoColumn || isFormula)
}

export type ExternalRequestReturnType<T extends Operation> =
  T extends Operation.READ ? Row[] : { row: Row; table: Table }

export class ExternalRequest<T extends Operation> {
  private readonly operation: T
  private readonly tableId: string
  private datasource?: Datasource
  private tables: { [key: string]: Table } = {}

  constructor(operation: T, tableId: string, datasource?: Datasource) {
    this.operation = operation
    this.tableId = tableId
    this.datasource = datasource
    if (datasource && datasource.entities) {
      this.tables = datasource.entities
    }
  }

  getTable(tableId: string | undefined): Table | undefined {
    if (!tableId) {
      throw "Table ID is unknown, cannot find table"
    }
    const { tableName } = breakExternalTableId(tableId)
    if (tableName) {
      return this.tables[tableName]
    }
  }

  inputProcessing(row: Row | undefined, table: Table) {
    if (!row) {
      return { row, manyRelationships: [] }
    }
    // we don't really support composite keys for relationships, this is why [0] is used
    // @ts-ignore
    const tablePrimary: string = table.primary[0]
    let newRow: Row = {},
      manyRelationships: ManyRelationship[] = []
    for (let [key, field] of Object.entries(table.schema)) {
      // if set already, or not set just skip it
      if (row[key] === undefined || newRow[key] || !isEditableColumn(field)) {
        continue
      }
      // parse floats/numbers
      if (field.type === FieldType.NUMBER && !isNaN(parseFloat(row[key]))) {
        newRow[key] = parseFloat(row[key])
      }
      // if its not a link then just copy it over
      if (field.type !== FieldType.LINK) {
        newRow[key] = row[key]
        continue
      }
      const { tableName: linkTableName } = breakExternalTableId(field?.tableId)
      // table has to exist for many to many
      if (!linkTableName || !this.tables[linkTableName]) {
        continue
      }
      const linkTable = this.tables[linkTableName]
      // @ts-ignore
      const linkTablePrimary = linkTable.primary[0]
      // one to many
      if (isOneSide(field)) {
        let id = row[key][0]
        if (id) {
          if (typeof row[key] === "string") {
            id = decodeURIComponent(row[key]).match(/\[(.*?)\]/)?.[1]
          }
          newRow[field.foreignKey || linkTablePrimary] = breakRowIdField(id)[0]
        } else {
          // Removing from both new and row, as we don't know if it has already been processed
          row[field.foreignKey || linkTablePrimary] = null
          newRow[field.foreignKey || linkTablePrimary] = null
        }
      }
      // many to many
      else if (isManyToMany(field)) {
        // we're not inserting a doc, will be a bunch of update calls
        const otherKey: string = field.throughFrom || linkTablePrimary
        const thisKey: string = field.throughTo || tablePrimary
        for (const relationship of row[key]) {
          manyRelationships.push({
            tableId: field.through || field.tableId,
            isUpdate: false,
            key: otherKey,
            [otherKey]: breakRowIdField(relationship)[0],
            // leave the ID for enrichment later
            [thisKey]: `{{ literal ${tablePrimary} }}`,
          })
        }
      }
      // many to one
      else {
        const thisKey: string = "id"
        // @ts-ignore
        const otherKey: string = field.fieldName
        for (const relationship of row[key]) {
          manyRelationships.push({
            tableId: field.tableId,
            isUpdate: true,
            key: otherKey,
            [thisKey]: breakRowIdField(relationship)[0],
            // leave the ID for enrichment later
            [otherKey]: `{{ literal ${tablePrimary} }}`,
          })
        }
      }
    }
    // we return the relationships that may need to be created in the through table
    // we do this so that if the ID is generated by the DB it can be inserted
    // after the fact
    return { row: newRow, manyRelationships }
  }

  processRelationshipFields(
    table: Table,
    row: Row,
    relationships: RelationshipsJson[]
  ): Row {
    for (let relationship of relationships) {
      const linkedTable = this.tables[relationship.tableName]
      if (!linkedTable || !row[relationship.column]) {
        continue
      }
      for (let key of Object.keys(row[relationship.column])) {
        let relatedRow: Row = row[relationship.column][key]
        // add this row as context for the relationship
        for (let col of Object.values(linkedTable.schema)) {
          if (col.type === FieldType.LINK && col.tableId === table._id) {
            relatedRow[col.name] = [row]
          }
        }
        // process additional types
        relatedRow = processDates(table, relatedRow)
        relatedRow = processFormulas(linkedTable, relatedRow)
        row[relationship.column][key] = relatedRow
      }
    }
    return row
  }

  outputProcessing(
    rows: Row[] = [],
    table: Table,
    relationships: RelationshipsJson[]
  ) {
    if (!rows || rows.length === 0 || rows[0].read === true) {
      return []
    }
    const tableMap = this.tables
    let finalRows: { [key: string]: Row } = {}
    for (let row of rows) {
      const rowId = generateIdForRow(row, table)
      row._id = rowId
      // this is a relationship of some sort
      if (finalRows[rowId]) {
        finalRows = updateRelationshipColumns(
          table,
          tableMap,
          row,
          finalRows,
          relationships
        )
        continue
      }
      const thisRow = fixArrayTypes(
        basicProcessing({ row, table, isLinked: false }),
        table
      )
      if (thisRow._id == null) {
        throw "Unable to generate row ID for SQL rows"
      }
      finalRows[thisRow._id] = thisRow
      // do this at end once its been added to the final rows
      finalRows = updateRelationshipColumns(
        table,
        tableMap,
        row,
        finalRows,
        relationships
      )
    }

    // make sure all related rows are correct
    let finalRowArray = Object.values(finalRows).map(row =>
      this.processRelationshipFields(table, row, relationships)
    )

    // process some additional types
    finalRowArray = processDates(table, finalRowArray)
    return finalRowArray
  }

  /**
   * This is a cached lookup, of relationship records, this is mainly for creating/deleting junction
   * information.
   */
  async lookupRelations(tableId: string, row: Row) {
    const related: { [key: string]: any } = {}
    const { tableName } = breakExternalTableId(tableId)
    if (!tableName) {
      return related
    }
    const table = this.tables[tableName]
    // @ts-ignore
    const primaryKey = table.primary[0]
    // make a new request to get the row with all its relationships
    // we need this to work out if any relationships need removed
    for (const field of Object.values(table.schema)) {
      if (
        field.type !== FieldType.LINK ||
        !field.fieldName ||
        isOneSide(field)
      ) {
        continue
      }
      const isMany = field.relationshipType === RelationshipType.MANY_TO_MANY
      const tableId = isMany ? field.through : field.tableId
      const { tableName: relatedTableName } = breakExternalTableId(tableId)
      // @ts-ignore
      const linkPrimaryKey = this.tables[relatedTableName].primary[0]

      const lookupField = isMany ? primaryKey : field.foreignKey
      const fieldName = isMany ? field.throughTo || primaryKey : field.fieldName
      if (!lookupField || !row[lookupField]) {
        continue
      }
      const response = await getDatasourceAndQuery({
        endpoint: getEndpoint(tableId, Operation.READ),
        filters: {
          equal: {
            [fieldName]: row[lookupField],
          },
        },
      })
      // this is the response from knex if no rows found
      const rows = !response[0].read ? response : []
      const storeTo = isMany ? field.throughFrom || linkPrimaryKey : fieldName
      related[storeTo] = { rows, isMany, tableId }
    }
    return related
  }

  /**
   * Once a row has been written we may need to update a many field, e.g. updating foreign keys
   * in a bunch of rows in another table, or inserting/deleting rows from a junction table (many to many).
   * This is quite a complex process and is handled by this function, there are a few things going on here:
   * 1. If updating foreign keys its relatively simple, just create a filter for the row that needs updated
   * and write the various components.
   * 2. If junction table, then we lookup what exists already, write what doesn't exist, work out what
   * isn't supposed to exist anymore and delete those. This is better than the usual method of delete them
   * all and then re-create, as theres no chance of losing data (e.g. delete succeed, but write fail).
   */
  async handleManyRelationships(
    mainTableId: string,
    row: Row,
    relationships: ManyRelationship[]
  ) {
    // if we're creating (in a through table) need to wipe the existing ones first
    const promises = []
    const related = await this.lookupRelations(mainTableId, row)
    for (let relationship of relationships) {
      const { key, tableId, isUpdate, id, ...rest } = relationship
      const body: { [key: string]: any } = processObjectSync(rest, row, {})
      const linkTable = this.getTable(tableId)
      const relationshipPrimary = linkTable?.primary || []
      const linkPrimary = relationshipPrimary[0]
      if (!linkTable || !linkPrimary) {
        return
      }

      const linkSecondary = relationshipPrimary[1]

      const rows = related[key]?.rows || []

      function relationshipMatchPredicate({
        row,
        linkPrimary,
        linkSecondary,
      }: {
        row: Row
        linkPrimary: string
        linkSecondary?: string
      }) {
        const matchesPrimaryLink =
          row[linkPrimary] === relationship.id ||
          row[linkPrimary] === body?.[linkPrimary]
        if (!matchesPrimaryLink || !linkSecondary) {
          return matchesPrimaryLink
        }

        const matchesSecondayLink = row[linkSecondary] === body?.[linkSecondary]
        return matchesPrimaryLink && matchesSecondayLink
      }

      const existingRelationship = rows.find((row: { [key: string]: any }) =>
        relationshipMatchPredicate({ row, linkPrimary, linkSecondary })
      )
      const operation = isUpdate ? Operation.UPDATE : Operation.CREATE
      if (!existingRelationship) {
        promises.push(
          getDatasourceAndQuery({
            endpoint: getEndpoint(tableId, operation),
            // if we're doing many relationships then we're writing, only one response
            body,
            filters: buildFilters(id, {}, linkTable),
          })
        )
      } else {
        // remove the relationship from cache so it isn't adjusted again
        rows.splice(rows.indexOf(existingRelationship), 1)
      }
    }
    // finally cleanup anything that needs to be removed
    for (let [colName, { isMany, rows, tableId }] of Object.entries(related)) {
      const table: Table | undefined = this.getTable(tableId)
      // if its not the foreign key skip it, nothing to do
      if (
        !table ||
        (!isMany && table.primary && table.primary.indexOf(colName) !== -1)
      ) {
        continue
      }
      for (let row of rows) {
        const filters = buildFilters(generateIdForRow(row, table), {}, table)
        // safety check, if there are no filters on deletion bad things happen
        if (Object.keys(filters).length !== 0) {
          const op = isMany ? Operation.DELETE : Operation.UPDATE
          const body = isMany ? null : { [colName]: null }
          promises.push(
            getDatasourceAndQuery({
              endpoint: getEndpoint(tableId, op),
              body,
              filters,
            })
          )
        }
      }
    }
    await Promise.all(promises)
  }

  async run(config: RunConfig): Promise<ExternalRequestReturnType<T>> {
    const { operation, tableId } = this
    let { datasourceId, tableName } = breakExternalTableId(tableId)
    if (!tableName) {
      throw "Unable to run without a table name"
    }
    if (!this.datasource) {
      this.datasource = await sdk.datasources.get(datasourceId!)
      if (!this.datasource || !this.datasource.entities) {
        throw "No tables found, fetch tables before query."
      }
      this.tables = this.datasource.entities
    }
    const table = this.tables[tableName]
    let isSql = isSQL(this.datasource)
    if (!table) {
      throw `Unable to process query, table "${tableName}" not defined.`
    }
    // look for specific components of config which may not be considered acceptable
    let { id, row, filters, sort, paginate, rows } = cleanupConfig(
      config,
      table
    )
    //if the sort column is a formula, remove it
    for (let sortColumn of Object.keys(sort || {})) {
      if (!sort?.[sortColumn]) {
        continue
      }
      switch (table.schema[sortColumn]?.type) {
        case FieldType.FORMULA:
          delete sort?.[sortColumn]
          break
        case FieldType.NUMBER:
          if (sort && sort[sortColumn]) {
            sort[sortColumn].type = SortType.number
          }
          break
      }
    }
    filters = buildFilters(id, filters || {}, table)
    const relationships = buildExternalRelationships(table, this.tables)

    const incRelationships =
      config.includeSqlRelationships === IncludeRelationship.INCLUDE

    // clean up row on ingress using schema
    const processed = this.inputProcessing(row, table)
    row = processed.row
    if (
      operation === Operation.DELETE &&
      (filters == null || Object.keys(filters).length === 0)
    ) {
      throw "Deletion must be filtered"
    }
    let json = {
      endpoint: {
        datasourceId,
        entityId: tableName,
        operation,
      },
      resource: {
        // have to specify the fields to avoid column overlap (for SQL)
        fields: isSql
          ? buildSqlFieldList(table, this.tables, {
              relationships: incRelationships,
            })
          : [],
      },
      filters,
      sort,
      paginate,
      relationships,
      body: row || rows,
      // pass an id filter into extra, purely for mysql/returning
      extra: {
        idFilter: buildFilters(id || generateIdForRow(row, table), {}, table),
      },
      meta: {
        table,
      },
    }

    // can't really use response right now
    const response = await getDatasourceAndQuery(json)
    // handle many to many relationships now if we know the ID (could be auto increment)
    if (operation !== Operation.READ) {
      await this.handleManyRelationships(
        table._id || "",
        response[0],
        processed.manyRelationships
      )
    }
    const output = sqlOutputProcessing(
      response,
      table,
      this.tables,
      relationships
    )
    // if reading it'll just be an array of rows, return whole thing
    if (operation === Operation.READ) {
      return (
        Array.isArray(output) ? output : [output]
      ) as ExternalRequestReturnType<T>
    } else {
      return { row: output[0], table } as ExternalRequestReturnType<T>
    }
  }
}
