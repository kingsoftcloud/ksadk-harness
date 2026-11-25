import { NATIVE_LOCAL_RESOURCE_PROFILES } from '@kingsoftcloud/agentkit-harness-core';
import { localControlSettings } from './local-process.mjs';

export const LOCAL_RESOURCE_PROFILE = 'agentkit.local-resource-profile/v1';
const UNBOUNDED = Number.MAX_SAFE_INTEGER;
const profiles = Object.freeze({
  'bounded/v1': Object.freeze({}),
  // Repository packs and build artifacts routinely exceed the restricted
  // per-file allowance. Keep a finite development allowance; explicit Host
  // settings always win. Other limits retain their existing values.
  'local-development/v1': Object.freeze({ maxFileBytes: 1024 ** 3 }),
  // Versioned development budget: allow long builds without changing old Runs
  // or the restricted profile. A Host's explicit lower limit still wins.
  'local-development/v2': Object.freeze({ cpuSeconds: 900, maxFileBytes: 1024 ** 3 }),
  // No per-command rlimits. A virtual address-space cap kills ordinary runtimes
  // (Node/V8, Go, JVM and Chromium reserve far more address space than they use),
  // and isolation belongs to the Host container, cgroup or sandbox. UNBOUNDED asks
  // the launcher for no extra limit; it clamps to the existing hard limit. The
  // wall-clock timeout, output cap, owner watchdog, process-group cleanup and the
  // governed command pre-check still apply. Explicit Host settings still win.
  'local-development/v3': Object.freeze({ cpuSeconds: UNBOUNDED, addressSpaceBytes: UNBOUNDED, maxProcesses: UNBOUNDED,
    maxOpenFiles: UNBOUNDED, maxFileBytes: UNBOUNDED }),
});
export function validLocalResourceProfile(profile) {
  return typeof profile === 'string' && NATIVE_LOCAL_RESOURCE_PROFILES.includes(profile) && Object.hasOwn(profiles, profile);
}

/** Host admission selects this policy, never a model/tool argument. */
export function localResourceSettings({ profile = 'bounded/v1', settings = {} } = {}) {
  if (!validLocalResourceProfile(profile)) throw Error('invalid_local_resource_profile');
  // Validate raw settings before merging: unknown keys/invalid overrides must
  // not be hidden by profile defaults.
  localControlSettings(settings);
  return localControlSettings({ ...profiles[profile], ...settings });
}

/** These are requested limits. Per-command receipts remain authoritative for
 * OS hard-limit clamping, unsupported controls and actual process outcomes. */
export function localResourceFacts(profile, settings) {
  if (!validLocalResourceProfile(profile)) throw Error('invalid_local_resource_profile');
  const selected = localControlSettings(settings);
  return { contract: LOCAL_RESOURCE_PROFILE, profile, requestedLimits: Object.fromEntries(
    ['cpuSeconds', 'addressSpaceBytes', 'maxProcesses', 'maxOpenFiles', 'maxFileBytes', 'wallSeconds']
      .map(key => [key, selected[key]])) };
}
