const assert = require('node:assert/strict');
const { buildEventRoles } = require('../src/services/feedService');

const normalize = (value) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

const isTurkey = (value) => {
  const n = normalize(value);
  return n === 'turkey' || n === 'turkiye' || n === 'turkiye';
};

const cases = [
  {
    text: 'Turkey condemns Iran missile strike on its soil',
    check: (roles) => {
      assert.equal(normalize(roles.actor), 'iran');
      assert.ok(isTurkey(roles.target));
    }
  },
  {
    text: 'Israel intercepts drone launched from Yemen',
    check: (roles) => {
      assert.equal(normalize(roles.actor), 'yemen');
      assert.equal(normalize(roles.target), 'israel');
    }
  },
  {
    text: 'Ukraine retaliates after Russian bombing of Kharkiv',
    check: (roles) => {
      assert.equal(normalize(roles.actor), 'russia');
      assert.equal(normalize(roles.target), 'kharkiv');
    }
  },
  {
    text: 'US sanctions Iran following attack on US base in Iraq',
    check: (roles) => {
      assert.equal(normalize(roles.actor), 'iran');
      assert.equal(normalize(roles.locationOfEvent), 'us base in iraq');
    }
  },
  {
    text: 'Russia protests NATO troop movements near its border',
    check: (roles) => {
      assert.equal(normalize(roles.actor), 'nato');
      assert.equal(normalize(roles.locationOfEvent), 'russia border');
    }
  }
];

let passed = 0;
for (const testCase of cases) {
  const roles = buildEventRoles(testCase.text);
  testCase.check(roles);
  passed += 1;
  console.log(`OK: ${testCase.text}`);
}

console.log(`\n${passed}/${cases.length} cas validés.`);
