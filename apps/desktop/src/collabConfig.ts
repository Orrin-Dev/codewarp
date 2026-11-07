import { COLLAB_DEV_SERVER_URL, COLLAB_SERVER_URL } from '@codewarp/core';

/** The one collaboration server this app talks to. `npm run dev` uses the local one so you can test. */
export function collabServerUrl(): string {
  return import.meta.env.DEV ? COLLAB_DEV_SERVER_URL : COLLAB_SERVER_URL;
}
