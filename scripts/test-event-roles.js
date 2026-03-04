const assert = require('node:assert/strict');
const { buildEventRoles, resolveGeoFromEventRoles } = require('../src/services/feedService');

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

const placementCases = [
  {
    text: 'Explosion near a nuclear facility in Iran',
    expectedCountry: 'iran'
  },
  {
    text: 'US informs Congress that Iranian drones are a massive threat',
    expectedCountry: 'united states'
  },
  {
    text: 'Iran launches missiles at the United States',
    expectedCountry: 'united states'
  },
  {
    text: 'Unknown source reports an incident with no location',
    expectedCountry: 'inconnu'
  }
];

const fallbackGeoSaudi = {
  countryInfo: {
    name: 'Arabie saoudite',
    code: 'SA',
    region: 'Moyen-Orient',
    lat: 23.8859,
    lng: 45.0792,
    area: 2149690
  },
  cityInfo: null,
  strategicArea: null,
  geoMeta: {}
};

for (const placementCase of placementCases) {
  const roles = buildEventRoles(placementCase.text);
  const resolved = resolveGeoFromEventRoles(placementCase.text, fallbackGeoSaudi, roles);
  const country = normalize(resolved?.countryInfo?.name);
  assert.equal(country, placementCase.expectedCountry);
  passed += 1;
  console.log(`OK: placement ${placementCase.text}`);
}

console.log(`\n${passed}/${cases.length + placementCases.length} cas validés.`);
