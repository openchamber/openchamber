const fs = require('fs');
const path = require('path');

// Read all locale files
const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'vi'];
const localeData = {};

for (const locale of locales) {
  const filePath = path.join(__dirname, '../packages/ui/messages', `${locale}.json`);
  const content = fs.readFileSync(filePath, 'utf8');
  localeData[locale] = JSON.parse(content);
}

// Get all keys from each locale
const allKeys = {};
for (const locale of locales) {
  for (const key in Object.keys(localeData[locale])) {
    allKeys[key] = true;
  }
}

// Now compare en.json against others to find missing keys
const enKeys = Object.keys(localeData['en']);
const missingKeys = [];

for (const locale of locales) {
  if (locale === 'en') continue;
  const otherKeys = Object.keys(localeData[locale]);
  for (const key of otherKeys) {
    if (!enKeys.includes(key)) {
      missingKeys.push({
        key,
        fallbackValues: {}
      });
    }
  }
}

// Build fallback values for each missing key
for (const key of missingKeys) {
  for (const locale of locales) {
    if (locale === 'en') continue;
      continue;
    }
    const value = localeData[locale][key];
    if (value && typeof value === 'string') {
      key.fallbackValues[locale] = value;
    }
  }
}

// Output results
console.log(`Total keys in en.json: ${enKeys.length}`);
console.log(`Missing keys count: ${missingKeys.length}`);
console.log('Missing keys:');
for (const key of missingKeys) {
  console.log(`  - ${key}`);
  for (const locale of locales) {
    if (locale !== 'en' && key.fallbackValues[locale]) {
      console.log(`    Fallback (${locale}): ${key.fallbackValues[locale]}`);
    }
  }
}

// Also show some sample keys with their values
console.log('\nSample of keys that exist in other locales but might need verification:');
const sampleKeys = [];
for (const locale of locales) {
  if (locale === 'en') continue;
    for (const key of Object.keys(localeData[locale])) {
      if (!enKeys.includes(key)) {
        sampleKeys.push(key);
        break;
      }
    }
  }
}

for (const key of sampleKeys.slice(0, 10)) {
  const enValue = localeData['en'][key];
  console.log(`  ${key}: en="${enValue || '(missing)'}"`);
}
