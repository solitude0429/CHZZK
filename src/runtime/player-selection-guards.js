import {
  QUALITY_PANE_SELECTOR,
  inheritedPropertyDescriptor,
  isCurrentTrack,
  playerTracks,
  resolveHighestConcretePlayerTrack,
  sameTrackQuality,
  trackDescriptor,
} from "./player-model.js";
const FILTER_WRAPPER_SLOT = Symbol.for("chzzk.highest-quality-filter-wrapper");
function ignorePageAccessFailure() {
  return false;
}

export function createPlayerSelectionGuards(documentRef, { requestSelection = () => {} } = {}) {
  const guardedTracks = new Map();
  let wrappedFilter = null;
  let wrappedFilterOwnDescriptor = null;
  let wrappedPane = null;

  function restoreWrappedFilter() {
    if (!wrappedPane || !wrappedFilter) return;
    try {
      const current = Object.getOwnPropertyDescriptor(wrappedPane, "filter");
      if (wrappedPane.filter === wrappedFilter && current?.value === wrappedFilter) {
        if (wrappedFilterOwnDescriptor) {
          Object.defineProperty(wrappedPane, "filter", wrappedFilterOwnDescriptor);
        } else {
          delete wrappedPane.filter;
        }
      }
    } catch {
      ignorePageAccessFailure();
    }
    wrappedFilter = null;
    wrappedFilterOwnDescriptor = null;
    wrappedPane = null;
  }

  function restoreTrackGuard(track) {
    const guard = guardedTracks.get(track);
    if (!guard) return;
    guardedTracks.delete(track);
    try {
      const current = Object.getOwnPropertyDescriptor(track, "selected");
      if (current?.get !== guard.get || current?.set !== guard.set) return;
      if (guard.ownDescriptor) {
        Object.defineProperty(track, "selected", guard.ownDescriptor);
      } else {
        delete track.selected;
      }
    } catch {
      ignorePageAccessFailure();
    }
  }

  function restoreTrackGuardsExcept(retainedTracks = null) {
    for (const track of [...guardedTracks.keys()]) {
      if (!retainedTracks?.has(track)) restoreTrackGuard(track);
    }
  }

  function ensureTrackSelectionGuards(resolution) {
    if (resolution?.outcome || !resolution?.player) {
      restoreTrackGuardsExcept();
      return;
    }
    const currentTracks = playerTracks(resolution.player);
    const retainedTracks = new Set(currentTracks);
    restoreTrackGuardsExcept(retainedTracks);

    for (const [index, track] of currentTracks.entries()) {
      const existingGuard = guardedTracks.get(track);
      if (existingGuard) {
        let currentDescriptor;
        try {
          currentDescriptor = Object.getOwnPropertyDescriptor(track, "selected");
        } catch {
          continue;
        }
        if (currentDescriptor?.get === existingGuard.get && currentDescriptor?.set === existingGuard.set) {
          continue;
        }
        guardedTracks.delete(track);
      }
      let ownDescriptor;
      try {
        ownDescriptor = Object.getOwnPropertyDescriptor(track, "selected");
      } catch {
        continue;
      }
      if (ownDescriptor && ownDescriptor.configurable !== true) continue;
      const selectedDescriptor = ownDescriptor ?? inheritedPropertyDescriptor(track, "selected");
      if (typeof selectedDescriptor?.get !== "function" || typeof selectedDescriptor?.set !== "function") {
        continue;
      }

      const get = function () {
        return Reflect.apply(selectedDescriptor.get, track, []);
      };
      const set = function (next) {
        if (next === true) {
          const currentResolution = resolveHighestConcretePlayerTrack(documentRef);
          if (!currentResolution.outcome) {
            const requested = trackDescriptor(track, index);
            const highest = currentResolution.candidate;
            if (highest?.track !== track && (!requested || !sameTrackQuality(requested, highest))) {
              if (!isCurrentTrack(currentResolution.player, highest)) {
                // Schedule through the controller: never write from a page-owned setter.
                // This shares its budget, pending confirmation, retry and stop lifecycle.
                try {
                  requestSelection();
                } catch {
                  ignorePageAccessFailure();
                }
              }
              return;
            }
          }
        }
        Reflect.apply(selectedDescriptor.set, track, [next]);
      };
      try {
        Object.defineProperty(track, "selected", {
          configurable: true,
          enumerable: selectedDescriptor.enumerable === true,
          get,
          set,
        });
        const installed = Object.getOwnPropertyDescriptor(track, "selected");
        if (installed?.get !== get || installed?.set !== set) continue;
      } catch {
        continue;
      }
      guardedTracks.set(track, {
        get,
        ownDescriptor,
        set,
      });
    }
  }

  function ensureHighestQualityFilter() {
    let pane;
    let filter;
    try {
      pane = documentRef?.querySelector?.(QUALITY_PANE_SELECTOR) ?? null;
      filter = pane?.filter;
    } catch {
      restoreWrappedFilter();
      return;
    }
    if (pane === wrappedPane && filter === wrappedFilter) return;
    restoreWrappedFilter();
    if (!pane || typeof filter !== "function") return;

    let ownDescriptor;
    let filterDescriptor;
    try {
      ownDescriptor = Object.getOwnPropertyDescriptor(pane, "filter");
      if (ownDescriptor && ownDescriptor.configurable !== true) return;
      filterDescriptor = ownDescriptor ?? inheritedPropertyDescriptor(pane, "filter");
    } catch {
      return;
    }
    const wrapper = function (track, ...args) {
      if (trackDescriptor(track, 0)) return true;
      return Reflect.apply(filter, this, [track, ...args]);
    };
    try {
      Object.defineProperty(wrapper, FILTER_WRAPPER_SLOT, {
        value: true,
      });
      Object.defineProperty(pane, "filter", {
        configurable: true,
        enumerable: filterDescriptor?.enumerable === true,
        value: wrapper,
        writable: true,
      });
      if (pane.filter !== wrapper) throw new Error("filter wrapper rejected");
    } catch {
      try {
        const current = Object.getOwnPropertyDescriptor(pane, "filter");
        if (current?.value === wrapper) {
          if (ownDescriptor) {
            Object.defineProperty(pane, "filter", ownDescriptor);
          } else {
            delete pane.filter;
          }
        }
      } catch {
        ignorePageAccessFailure();
      }
      return;
    }
    wrappedFilter = wrapper;
    wrappedFilterOwnDescriptor = ownDescriptor;
    wrappedPane = pane;
  }

  function resolveControllerPlayerTrack() {
    ensureHighestQualityFilter();
    const resolution = resolveHighestConcretePlayerTrack(documentRef);
    ensureTrackSelectionGuards(resolution);
    return resolution;
  }

  return Object.freeze({
    resolve: resolveControllerPlayerTrack,
    restore() {
      restoreTrackGuardsExcept();
      restoreWrappedFilter();
    },
  });
}
