export const createOpenCodeResolutionRuntime = (dependencies) => {
  const {
    path,
    resolveOpencodeCliPath,
    applyOpencodeBinaryFromSettings,
    ensureOpencodeCliEnv,
    opencodeShimInterpreter,
    getResolvedState,
    setResolvedOpencodeBinarySource,
  } = dependencies;

  const getOpenCodeResolutionSnapshot = async (settings) => {
    const configured = typeof settings?.opencodeBinary === 'string' ? settings.opencodeBinary : null;

    const { resolvedOpencodeBinarySource: previousSource } = getResolvedState();
    const detectedNow = resolveOpencodeCliPath();
    const { resolvedOpencodeBinarySource: rawDetectedSourceNow } = getResolvedState();
    setResolvedOpencodeBinarySource(previousSource);

    await applyOpencodeBinaryFromSettings();
    ensureOpencodeCliEnv();

    const {
      resolvedOpencodeBinary,
      resolvedOpencodeBinarySource,
      useWslForOpencode,
      resolvedWslBinary,
      resolvedWslOpencodePath,
      resolvedWslDistro,
      resolvedNodeBinary,
      resolvedBunBinary,
    } = getResolvedState();

    const resolved = resolvedOpencodeBinary || null;
    const source = resolvedOpencodeBinarySource || null;
    const detectedSourceNow =
      detectedNow &&
      resolved &&
      detectedNow === resolved &&
      rawDetectedSourceNow === 'env' &&
      source &&
      source !== 'env'
        ? source
        : rawDetectedSourceNow;
    const shim = resolved ? opencodeShimInterpreter(resolved) : null;

    return {
      configured,
      resolved,
      resolvedDir: resolved ? path.dirname(resolved) : null,
      source,
      detectedNow,
      detectedSourceNow,
      shim,
      viaWsl: useWslForOpencode,
      wslBinary: resolvedWslBinary || null,
      wslPath: resolvedWslOpencodePath || null,
      wslDistro: resolvedWslDistro || null,
      node: resolvedNodeBinary || null,
      bun: resolvedBunBinary || null,
    };
  };

  return {
    getOpenCodeResolutionSnapshot,
  };
};
