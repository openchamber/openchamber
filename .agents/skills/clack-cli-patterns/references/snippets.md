# CLI Output Snippets

## Prompt Guard

```js
if (canPrompt(options)) {
  const value = await select({
    message: 'Choose an option',
    options: [{ value: 'a', label: 'Option A' }],
  });
  if (isCancel(value)) {
    cancel('Operation cancelled.');
    return;
  }
}
```

## Non-Interactive Fallback

```js
if (!resolvedValue) {
  if (canPrompt(options)) {
    // prompt path
  } else {
    throw new Error('Missing required value. Provide --flag <value>.');
  }
}
```

## Spinner Guard

```js
const spin = createSpinner(options);
spin?.start('Running operation...');
// ...work...
spin?.stop('Done');
```

## JSON vs Human Output

```js
if (options.json) {
  printJson({ ok: true, data });
  return;
}

intro('Operation');
log.success('Completed');
outro('done');
```
