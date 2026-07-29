/**
 * Firebase Cloud Storage — screenshot uploads.
 *
 * @module lib/storage
 */

'use client';

import { getFirebaseStorage, isStorageConfigured } from './firebase';
import { getUid } from './auth';

export interface UploadResult {
  url: string;
  path: string;
}

/**
 * Uploads a screenshot data URL to Cloud Storage.
 *
 * The data URL is converted to a `Blob` before upload rather than using
 * `uploadString(..., 'data_url')`. Both work, but the blob path avoids holding
 * a second base64 copy of a multi-megabyte image in memory — base64 inflates
 * binary by ~33 %, and a 4K screenshot is not small.
 *
 * @param dataUrl - A `data:image/jpeg;base64,…` string.
 * @param worldSeed - Recorded in the object's metadata for later filtering.
 * @returns The download URL and storage path, or `null` if unavailable.
 */
export async function uploadScreenshot(
  dataUrl: string,
  worldSeed: string,
): Promise<UploadResult | null> {
  if (!isStorageConfigured) return null;

  const uid = getUid();
  const storage = await getFirebaseStorage();
  if (!uid || !storage) return null;

  try {
    const { ref, uploadBytes, getDownloadURL } = await import('firebase/storage');

    const blob = dataUrlToBlob(dataUrl);
    if (!blob) return null;

    /* Path is scoped by UID so the security rules can be a simple
     * `request.auth.uid == uid` check on the path segment — no document lookup
     * required, which keeps writes fast and rules cheap. */
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const path = `screenshots/${uid}/${filename}`;
    const objectRef = ref(storage, path);

    await uploadBytes(objectRef, blob, {
      contentType: 'image/jpeg',
      cacheControl: 'public, max-age=31536000, immutable',
      customMetadata: { worldSeed, uid },
    });

    const url = await getDownloadURL(objectRef);
    return { url, path };
  } catch (err) {
    console.warn('[storage] Screenshot upload failed.', err);
    return null;
  }
}

/** Deletes an uploaded screenshot. */
export async function deleteScreenshot(path: string): Promise<boolean> {
  const storage = await getFirebaseStorage();
  if (!storage) return false;
  try {
    const { ref, deleteObject } = await import('firebase/storage');
    await deleteObject(ref(storage, path));
    return true;
  } catch (err) {
    console.warn('[storage] Delete failed.', err);
    return false;
  }
}

/**
 * Converts a data URL to a Blob without an intermediate fetch.
 *
 * `fetch(dataUrl).then(r => r.blob())` also works and is shorter, but it is
 * asynchronous and — under some Content-Security-Policy configurations —
 * blocked outright, because `data:` counts as a network scheme. Decoding
 * manually has neither problem.
 */
function dataUrlToBlob(dataUrl: string): Blob | null {
  try {
    const [header, base64] = dataUrl.split(',');
    if (!header || !base64) return null;
    const mimeMatch = header.match(/data:([^;]+)/);
    const mime = mimeMatch?.[1] ?? 'image/jpeg';

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch (err) {
    console.warn('[storage] Could not decode data URL.', err);
    return null;
  }
}

/** Triggers a browser download of a data URL, for the local-save path. */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
