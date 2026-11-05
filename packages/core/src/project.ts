/**
 * Minimal typed view of the Scratch 3 project format (project.json inside an .sb3).
 * The project JSON is Codewarp's single source of truth: the blocks editor and
 * (later) the C#-style and Python-style text syntaxes are all views of it.
 */

export interface Sb3Meta {
  semver: string;
  vm: string;
  agent: string;
}

export interface Sb3Block {
  opcode: string;
  next: string | null;
  parent: string | null;
  inputs: Record<string, unknown>;
  fields: Record<string, unknown>;
  shadow: boolean;
  topLevel: boolean;
  x?: number;
  y?: number;
  mutation?: unknown;
}

export interface Sb3Target {
  isStage: boolean;
  name: string;
  variables: Record<string, unknown>;
  lists: Record<string, unknown>;
  broadcasts: Record<string, string>;
  blocks: Record<string, Sb3Block | unknown[]>;
  comments: Record<string, unknown>;
  currentCostume: number;
  costumes: unknown[];
  sounds: unknown[];
  volume: number;
  layerOrder: number;
  [key: string]: unknown;
}

export interface Sb3Project {
  targets: Sb3Target[];
  monitors: unknown[];
  extensions: string[];
  meta: Sb3Meta;
}

/**
 * Every Scratch stage needs at least one costume (backdrop), or the project fails validation.
 * This is a plain white 480x360 backdrop. BLANK_BACKDROP_ID is the MD5 of BLANK_BACKDROP_SVG
 * and must be changed together with it (the file is stored in the .sb3 as `<id>.svg`).
 */
export const BLANK_BACKDROP_SVG =
    '<svg version="1.1" width="480" height="360" viewBox="0 0 480 360" xmlns="http://www.w3.org/2000/svg"><rect width="480" height="360" fill="#ffffff"/></svg>';
export const BLANK_BACKDROP_ID = 'a416bbdcf42506ac7299d5e160413479';

/** A stage-only project with a blank backdrop. */
export function emptyProject(): Sb3Project {
  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: {},
        currentCostume: 0,
        costumes: [
          {
            assetId: BLANK_BACKDROP_ID,
            name: 'backdrop1',
            md5ext: `${BLANK_BACKDROP_ID}.svg`,
            dataFormat: 'svg',
            rotationCenterX: 240,
            rotationCenterY: 180,
          },
        ],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'on',
        textToSpeechLanguage: null,
      },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: '0.2.0', agent: 'Codewarp' },
  };
}

export function emptyProjectJson(): string {
  return JSON.stringify(emptyProject());
}