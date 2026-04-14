const fs = require('fs');
const path = require('path');

const messagesDir = path.join(__dirname, '../packages/ui/messages');

// Read en.json
const enContent = fs.readFileSync(path.join(messagesDir, 'en.json'), 'utf8');
const enData = JSON.parse(enContent);
const enKeys = Object.keys(enData);

// Read other locale files
const locales = ['zh-CN', 'zh-TW', 'ja', 'vi'];
const otherData = {};

for (const locale of locales) {
  const content = fs.readFileSync(path.join(messagesDir, `${locale}.json`), 'utf8');
  const data = JSON.parse(content);
  otherData[locale] = data;
}

// Find missing keys in en.json
const missingKeys = [];

for (const key in enKeys) {
  const keyInAll = Object.values(otherData).some(data => data.hasOwnProperty(key));
  if (!keyInAll) {
    missingKeys.push(key);
  }
}

// Build a map of missing keys with their fallback values
const missingKeyMap = {};
for (const key of missingKeys) {
  missingKeyMap[key] = {};
  for (const locale of locales) {
    if (locale !== 'en' && otherData[locale][key] && typeof otherData[locale][key] === 'string') {
      missingKeyMap[key][locale] = otherData[locale][key];
    }
  }
}

console.log(`\n=== MISSING KEYS ANALYSIS ===`);
console.log(`Total keys in en.json: ${enKeys.length}`);
console.log(`Missing keys: ${missingKeys.length}`);
console.log('\nKeys with fallback translations:');
for (const key of missingKeys) {
  console.log(`  ${key}`);
  const hasFallback = Object.keys(missingKeyMap[key]).length > 0;
  if (hasFallback) {
    console.log(`    Fallbacks: ${Object.keys(missingKeyMap[key]).join(', ')}`);
    for (const locale of locales) {
      if (missingKeyMap[key][locale]) {
        console.log(`      ${locale}: ${missingKeyMap[key][locale]}`);
      }
    }
  } else {
    console.log(`    (no fallback - needs manual translation)`);
  }
  }
}

// Also show keys that are in other locales but not in en.json and have English values
console.log('\n\n=== KEYS IN OTHER LOCALES BUT NOT IN EN (with English values) ===');
const keysInOtherWithEnglish = [];
for (const locale of locales) {
  if (locale === 'en') continue;
  for (const key of Object.keys(otherData[locale])) {
    if (!enKeys.includes(key)) {
      const value = otherData[locale][key];
      if (value && typeof value === 'string' && /^[a-zA-Z\s]+$/.test(value)) {
        keysInOtherWithEnglish.push(key);
      }
    }
  }
}

console.log(`Count: ${keysInOtherWithEnglish.length}`);
for (const key of keysInOtherWithEnglish) {
  console.log(`  ${key}: ${Object.values(otherData['en'])[key]}`);
}
