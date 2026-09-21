export const resolveStartupUrlProbePlan = ({ development, packagedUi, skipLocalServer }) => ({
  probeHmrApi: development === true && packagedUi !== true && skipLocalServer !== true,
  probeHmrUi: development === true && packagedUi !== true,
});

export const shouldIgnoreLoopbackConnectionLimit = ({ development, packagedUi }) => (
  development !== true || packagedUi === true
);
