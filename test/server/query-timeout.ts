import { expect, test, describe } from 'vitest'
import { app } from './utils'
import { pgMeta } from '../lib/utils'

describe('test query timeout', () => {
  test('query timeout after 3s and connection cleanup', async () => {
    const query = `SELECT pg_sleep(10);`
    // Execute a query that will sleep for 10 seconds
    const res = await app.inject({
      method: 'POST',
      path: '/query',
      payload: {
        query,
      },
    })

    // Check that we get the proper timeout error response
    expect(res.statusCode).toBe(408) // Request Timeout
    expect(res.json()).toMatchObject({
      error: expect.stringContaining('Query read timeout'),
    })
    // wait one second for the statement timeout to take effect
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Verify that the connection has been cleaned up by checking active connections
    const connectionsRes = await pgMeta.query(`
      SELECT * FROM pg_stat_activity where application_name = 'postgres-meta 0.0.0-automated' and query ILIKE '%${query}%';
    `)

    // Should have no active connections except for our current query
    expect(connectionsRes.data).toHaveLength(0)
  }, 5000)
})
