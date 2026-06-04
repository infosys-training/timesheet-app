const underThresholdEntries = [
  { hours: 10, description: 'Work A', date: '2024-01-08', client_name: 'Client A' },
  { hours: 15, description: 'Work B', date: '2024-01-09', client_name: 'Client A' }
];

const overThresholdEntries = [
  { hours: 20, description: 'Work A', date: '2024-01-08', client_name: 'Client A' },
  { hours: 15, description: 'Work B', date: '2024-01-09', client_name: 'Client B' },
  { hours: 10, description: 'Work C', date: '2024-01-10', client_name: 'Client A' }
];

function createMockDb() {
  return { all: jest.fn(), get: jest.fn(), run: jest.fn() };
}

module.exports = { underThresholdEntries, overThresholdEntries, createMockDb };
