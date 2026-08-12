import { describe, it, expect } from 'vitest';
import { validateScene, unverifiedItems, SceneValidationError } from './scene.ts';
import type { SceneConfig } from './scene.ts';

function baseScene(): SceneConfig {
  return {
    id: 'test',
    name: 'Test',
    bbox: { latMin: 37.75, latMax: 37.95, lonMin: -122.55, lonMax: -122.25 },
    verticalDatum: 'egm2008',
    datumSeparations: { separations: { egm2008: 32.3 }, sources: { egm2008: 'cited' } },
    terrain: { provider: 'terrarium', cellSizeMetres: 20 },
    buildings: { provider: 'overture', release: '2026-07-22.0', minHeightMetres: 15 },
    observers: [
      { id: 'obs', name: 'Observer', lat: 37.89, lon: -122.32, eyeHeight: 1.6, verified: true },
    ],
    targets: [
      { id: 'tgt', name: 'Target', lat: 37.79, lon: -122.4, verified: true },
    ],
  };
}

describe('validateScene', () => {
  it('accepts a well-formed scene', () => {
    expect(() => validateScene(baseScene())).not.toThrow();
  });

  it('rejects an inverted bbox', () => {
    const s = baseScene();
    s.bbox.latMin = 38;
    expect(() => validateScene(s)).toThrow(SceneValidationError);
  });

  it('rejects an antimeridian-crossing bbox rather than silently spanning the planet', () => {
    const s = baseScene();
    s.bbox.lonMin = 179;
    s.bbox.lonMax = -179;
    s.observers = [];
    s.targets = [];
    expect(() => validateScene(s)).toThrow(/antimeridian/);
  });

  it('rejects points outside the box', () => {
    const s = baseScene();
    s.targets[0]!.lat = 40;
    expect(() => validateScene(s)).toThrow(/outside the scene bbox/);
  });

  it('rejects duplicate ids', () => {
    const s = baseScene();
    s.targets[0]!.id = 'obs';
    expect(() => validateScene(s)).toThrow(/duplicate point ids/);
  });

  it('rejects a scene whose own datum has no separation', () => {
    const s = baseScene();
    s.datumSeparations = { separations: {}, sources: {} };
    expect(() => validateScene(s)).toThrow(/no datum separation/);
  });

  it('reports every problem at once rather than one per run', () => {
    const s = baseScene();
    s.bbox.latMin = 38;
    s.observers[0]!.eyeHeight = 0;
    try {
      validateScene(s);
      expect.unreachable();
    } catch (err) {
      expect((err as SceneValidationError).problems.length).toBeGreaterThan(1);
    }
  });
});

describe('unverifiedItems', () => {
  it('is empty when everything is cited', () => {
    expect(unverifiedItems(baseScene())).toEqual([]);
  });

  it('flags unverified coordinates', () => {
    const s = baseScene();
    s.targets[0]!.verified = false;
    expect(unverifiedItems(s)).toHaveLength(1);
    expect(unverifiedItems(s)[0]).toMatch(/coordinates unverified/);
  });

  it('flags placeholder datum separations', () => {
    const s = baseScene();
    s.datumSeparations.sources.egm2008 = 'PLACEHOLDER: guessed';
    expect(unverifiedItems(s).join(' ')).toMatch(/PLACEHOLDER/);
  });
});
