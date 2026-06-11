import { describe, expect, it } from 'vitest';

import { createDisabledRemoteAccessStatus } from '../../src/domain/server-state.js';
import { SERVER_STATE_BOOTSTRAP_CATEGORIES } from '../../src/domain/server-state-bootstrap.js';
import {
  getServerStateBootstrap,
  getServerStateBootstrapVersions,
  type ServerStateBootstrapContext,
} from './server-state-bootstrap.js';

function buildContext(): ServerStateBootstrapContext {
  return {
    getPeerPresenceSnapshots: () => [],
    getPeerPresenceVersion: () => 41,
    getRemoteStatus: () => createDisabledRemoteAccessStatus(7777),
    getRemoteStatusVersion: () => 23,
  };
}

// getServerStateBootstrapVersions is the retained ResyncVersionMap seam for the
// delta-resync item: per-category entries must stay equal to each live source's
// version, cover exactly the bootstrap categories, and never mint the
// 'workspace' or 'agents' members (those version spaces have other owners).
describe('getServerStateBootstrapVersions', () => {
  it('covers exactly the server-state bootstrap categories', () => {
    const versions = getServerStateBootstrapVersions(buildContext());

    expect(Object.keys(versions).sort()).toEqual([...SERVER_STATE_BOOTSTRAP_CATEGORIES].sort());
    expect('workspace' in versions).toBe(false);
    expect('agents' in versions).toBe(false);
  });

  it('reports each category version from the same live source as the bootstrap snapshot', () => {
    const context = buildContext();

    const versions = getServerStateBootstrapVersions(context);
    const snapshots = getServerStateBootstrap(context);

    expect(snapshots).toHaveLength(SERVER_STATE_BOOTSTRAP_CATEGORIES.length);
    for (const snapshot of snapshots) {
      expect('degraded' in snapshot).toBe(false);
      if ('version' in snapshot) {
        expect(versions[snapshot.category]).toBe(snapshot.version);
      }
    }
  });

  it('uses the injected context versions for remote-status and peer-presence', () => {
    const versions = getServerStateBootstrapVersions(buildContext());

    expect(versions['remote-status']).toBe(23);
    expect(versions['peer-presence']).toBe(41);
  });
});
