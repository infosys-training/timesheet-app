jest.mock('sqlite3', () => jest.requireActual('sqlite3'));

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const backendInitializer = fs.readFileSync(
  path.resolve(__dirname, '../../database/init.js'),
  'utf8'
);
const dockerInitializer = fs.readFileSync(
  path.resolve(__dirname, '../../../../docker/overrides/database/init.js'),
  'utf8'
);

function extractCreateTableStatements(source) {
  return [...source.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \([\s\S]*?\n\s+\)/g)].map(
    ([statement, name]) => ({ name, statement })
  );
}

function run(database, query) {
  return new Promise((resolve, reject) => {
    database.run(query, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function all(database, query) {
  return new Promise((resolve, reject) => {
    database.all(query, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows);
    });
  });
}

async function createSchema(statements) {
  const database = new sqlite3.Database(':memory:');
  for (const { statement } of statements) {
    await run(database, statement);
  }
  return database;
}

function close(database) {
  return new Promise((resolve, reject) => {
    database.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe('database schema parity', () => {
  let backendDatabase;
  let dockerDatabase;

  beforeAll(async () => {
    backendDatabase = await createSchema(extractCreateTableStatements(backendInitializer));
    dockerDatabase = await createSchema(extractCreateTableStatements(dockerInitializer));
  });

  afterAll(async () => {
    await close(backendDatabase);
    await close(dockerDatabase);
  });

  test('keeps table columns aligned between backend and Docker initializers', async () => {
    const backendTables = extractCreateTableStatements(backendInitializer);
    const dockerTables = extractCreateTableStatements(dockerInitializer);

    expect(dockerTables.map(({ name }) => name)).toEqual(backendTables.map(({ name }) => name));

    for (const { name } of backendTables) {
      const selectColumns = ({ name: columnName, type, notnull }) => ({
        name: columnName,
        type,
        notnull
      });
      const backendColumns = (await all(backendDatabase, `PRAGMA table_info(${name})`)).map(selectColumns);
      const dockerColumns = (await all(dockerDatabase, `PRAGMA table_info(${name})`)).map(selectColumns);

      expect(dockerColumns).toEqual(backendColumns);
    }
  });
});
