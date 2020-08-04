import { Router } from 'express'
import SQL from 'sql-template-strings'
import { RunQuery } from '../lib/connectionPool'
import sql = require('../lib/sql')
import { DEFAULT_SYSTEM_SCHEMAS } from '../lib/constants'
import { Tables } from '../lib/interfaces'

/**
 * @param {boolean} [include_system_schemas=false] - Return system schemas as well as user schemas
 */
interface QueryParams {
  include_system_schemas?: string
}

const router = Router()
const { columns, tables } = sql

router.get('/', async (req, res) => {
  try {
    const { data } = await RunQuery(req.headers.pg, columns)
    const query: QueryParams = req.query
    const include_system_schemas = query?.include_system_schemas === 'true'
    let payload: Tables.Column[] = data
    if (!include_system_schemas) payload = removeSystemSchemas(data)
    return res.status(200).json(payload)
  } catch (error) {
    console.log('throwing error')
    res.status(500).json({ error: 'Database error.', status: 500 })
  }
})

router.post('/', async (req, res) => {
  try {
    const tableId: number = req.body.table_id
    const name: string = req.body.name
    const getTableQuery = getTableSqlize(tableId)
    const { name: table, schema } = (await RunQuery(req.headers.pg, getTableQuery)).data[0]

    const addColumnArgs = req.body
    delete addColumnArgs.table_id
    addColumnArgs.table = table
    addColumnArgs.schema = schema
    const query = addColumnSqlize(addColumnArgs)
    await RunQuery(req.headers.pg, query)

    const getColumnQuery = getColumnSqlize(tableId, name)
    const column = (await RunQuery(req.headers.pg, getColumnQuery)).data[0]

    return res.status(200).json(column)
  } catch (error) {
    console.log('throwing error', error)
    res.status(500).json({ error: 'Database error', status: 500 })
  }
})

router.patch('/:id', async (req, res) => {
  try {
    const [tableId, ordinalPos] = req.params.id.split('.').map(Number)
    const getColumnQuery = getColumnByPosSqlize(tableId, ordinalPos)
    const column = (await RunQuery(req.headers.pg, getColumnQuery)).data[0]
    const { schema, table, name: oldName } = column

    const alterColumnArgs = req.body
    alterColumnArgs.schema = schema
    alterColumnArgs.table = table
    alterColumnArgs.oldName = oldName
    const query = alterColumnSqlize(alterColumnArgs)
    await RunQuery(req.headers.pg, query)

    const updated = (await RunQuery(req.headers.pg, getColumnQuery)).data[0]
    return res.status(200).json(updated)
  } catch (error) {
    console.log('throwing error', error)
    res.status(500).json({ error: 'Database error', status: 500 })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const [tableId, ordinalPos] = req.params.id.split('.').map(Number)
    const getColumnQuery = getColumnByPosSqlize(tableId, ordinalPos)
    const column = (await RunQuery(req.headers.pg, getColumnQuery)).data[0]
    const { schema, table, name } = column

    const query = dropColumnSqlize(schema, table, name)
    await RunQuery(req.headers.pg, query)

    return res.status(200).json(column)
  } catch (error) {
    console.log('throwing error', error)
    res.status(500).json({ error: 'Database error', status: 500 })
  }
})

const getTableSqlize = (id: number) => {
  return SQL``.append(tables).append(SQL` AND c.oid = ${id}`)
}
const addColumnSqlize = ({
  schema,
  table,
  name,
  type,
  default_value,
  is_identity = false,
  is_nullable = true,
  is_primary_key = false,
  is_unique = false,
  comment,
}: {
  schema: string
  table: string
  name: string
  type: string
  default_value?: any
  is_identity?: boolean
  is_nullable?: boolean
  is_primary_key?: boolean
  is_unique?: boolean
  comment?: string
}) => {
  const defaultValueSql = default_value === undefined ? '' : `DEFAULT ${default_value}`
  const isIdentitySql = is_identity ? 'GENERATED BY DEFAULT AS IDENTITY' : ''
  const isNullableSql = is_nullable ? 'NULL' : 'NOT NULL'
  const isPrimaryKeySql = is_primary_key ? 'PRIMARY KEY' : ''
  const isUniqueSql = is_unique ? 'UNIQUE' : ''
  const commentSql =
    comment === undefined
      ? ''
      : `COMMENT ON COLUMN "${schema}"."${table}"."${name}" IS '${comment}';`

  return `
ALTER TABLE "${schema}"."${table}" ADD COLUMN "${name}" "${type}"
  ${defaultValueSql}
  ${isIdentitySql}
  ${isNullableSql}
  ${isPrimaryKeySql}
  ${isUniqueSql};

  ${commentSql}`
}
const getColumnSqlize = (tableId: number, name: string) => {
  return SQL``.append(columns).append(SQL` WHERE c.oid = ${tableId} AND column_name = ${name}`)
}
const getColumnByPosSqlize = (tableId: number, ordinalPos: number) => {
  return SQL``
    .append(columns)
    .append(SQL` WHERE c.oid = ${tableId} AND ordinal_position = ${ordinalPos}`)
}
const alterColumnSqlize = ({
  schema,
  table,
  oldName,
  name,
  type,
  drop_default = false,
  default_value,
  is_nullable,
  comment,
}: {
  schema: string
  table: string
  oldName: string
  name?: string
  type?: string
  drop_default?: boolean
  default_value?: any
  is_nullable?: boolean
  comment?: string
}) => {
  const nameSql =
    typeof name === 'undefined' || name === oldName
      ? ''
      : `ALTER TABLE "${schema}"."${table}" RENAME COLUMN "${oldName}" TO "${name}";`
  const typeSql =
    type === undefined
      ? ''
      : `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${oldName}" SET DATA TYPE "${type}";`
  let defaultValueSql = ''
  if (drop_default) {
    defaultValueSql = `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${oldName}" DROP DEFAULT;`
  } else if (default_value !== undefined) {
    defaultValueSql = `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${oldName}" SET DEFAULT ${default_value};`
  }
  let isNullableSql = ''
  if (is_nullable !== undefined) {
    isNullableSql = is_nullable
      ? `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${oldName}" DROP NOT NULL;`
      : `ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${oldName}" SET NOT NULL;`
  }
  const commentSql =
    comment === undefined
      ? ''
      : `COMMENT ON COLUMN "${schema}"."${table}"."${oldName}" IS '${comment}';`

  // nameSql must be last.
  return `
BEGIN;
  ${isNullableSql}
  ${defaultValueSql}
  ${typeSql}
  ${commentSql}
  ${nameSql}
COMMIT;`
}
const dropColumnSqlize = (schema: string, table: string, name: string) => {
  return `ALTER TABLE "${schema}"."${table}" DROP COLUMN "${name}"`
}
const removeSystemSchemas = (data: Tables.Column[]) => {
  return data.filter((x) => !DEFAULT_SYSTEM_SCHEMAS.includes(x.schema))
}

export = router
