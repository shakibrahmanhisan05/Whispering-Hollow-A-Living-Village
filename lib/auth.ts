/**
 * Authentication.
 *
 * ## The anonymous-first flow
 *
 * Players are signed in **anonymously and automatically** on first load. They
 * never see a login wall; progress just starts saving. Later, if they want that
 * progress on another device, they can upgrade the anonymous account to Google
 * — and because `linkWithPopup` promotes the *existing* account rather than
 * creating a new one, every achievement and screenshot comes with them.
 *
 * The one case that needs care is when the Google account is already linked to
 * a different Firebase user (they've played on another device). Then linking
 * fails with `credential-already-in-use`, and the honest thing is to sign into
 * that existing account and tell the player their local progress could not be
 * merged — rather than silently discarding one side.
 *
 * @module lib/auth
 */

'use client';

import type { User } from 'firebase/auth';
import { getFirebaseAuth, isFirebaseConfigured } from './firebase';

export interface AuthState {
  user: User | null;
  /** True while the initial auth check is in flight. */
  loading: boolean;
  /** True when signed in with a real (non-anonymous) provider. */
  isLinked: boolean;
  error: string | null;
}

type Listener = (state: AuthState) => void;

const listeners = new Set<Listener>();
let current: AuthState = {
  user: null,
  loading: isFirebaseConfigured,
  isLinked: false,
  error: null,
};
let initialised = false;

function emit(next: Partial<AuthState>): void {
  current = { ...current, ...next };
  listeners.forEach((l) => l(current));
}

/** Current auth state, synchronously. */
export function getAuthState(): AuthState {
  return current;
}

/** Subscribes to auth changes. Returns an unsubscribe function. */
export function subscribeAuth(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

/**
 * Starts the auth flow: attaches the state observer and signs in anonymously
 * if nobody is signed in. Idempotent.
 */
export async function initAuth(): Promise<void> {
  if (initialised) return;
  initialised = true;

  if (!isFirebaseConfigured) {
    emit({ loading: false });
    return;
  }

  const auth = await getFirebaseAuth();
  if (!auth) {
    emit({ loading: false, error: 'Firebase auth unavailable' });
    return;
  }

  try {
    const { onAuthStateChanged, signInAnonymously } = await import('firebase/auth');

    onAuthStateChanged(
      auth,
      (user) => {
        emit({
          user,
          loading: false,
          isLinked: Boolean(user && !user.isAnonymous),
          error: null,
        });

        /* No user at all — sign in anonymously so saving works immediately.
         * Guarded so a sign-out doesn't immediately sign back in. */
        if (!user && !signingOut) {
          void signInAnonymously(auth).catch((err) => {
            console.warn('[auth] Anonymous sign-in failed.', err);
            emit({ error: 'Could not sign in; progress will be saved locally only.' });
          });
        }
      },
      (err) => {
        console.warn('[auth] Observer error.', err);
        emit({ loading: false, error: err.message });
      },
    );
  } catch (err) {
    console.warn('[auth] Initialisation failed.', err);
    emit({ loading: false, error: 'Auth unavailable' });
  }
}

let signingOut = false;

/**
 * Upgrades the current anonymous account to Google, preserving all progress.
 *
 * @returns An outcome describing what happened, so the UI can explain it.
 */
export async function upgradeToGoogle(): Promise<
  | { ok: true; merged: true }
  | { ok: true; merged: false; reason: 'switched-account' }
  | { ok: false; error: string }
> {
  const auth = await getFirebaseAuth();
  if (!auth) return { ok: false, error: 'Firebase is not configured.' };

  try {
    const { GoogleAuthProvider, linkWithPopup, signInWithPopup } = await import('firebase/auth');
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    const user = auth.currentUser;

    if (user?.isAnonymous) {
      try {
        /* The happy path: promote this anonymous account. The UID does not
         * change, so every Firestore document keyed on it comes along. */
        await linkWithPopup(user, provider);
        return { ok: true, merged: true };
      } catch (err) {
        const code = (err as { code?: string })?.code;

        if (code === 'auth/credential-already-in-use' || code === 'auth/email-already-in-use') {
          /* This Google account already has a Whispering Hollow save. We
           * cannot merge two Firebase users client-side, so sign into the
           * existing one and be explicit that the local anonymous progress
           * has not been carried over. */
          await signInWithPopup(auth, provider);
          return { ok: true, merged: false, reason: 'switched-account' };
        }
        throw err;
      }
    }

    // Not anonymous (or nobody signed in) — a plain sign-in.
    await signInWithPopup(auth, provider);
    return { ok: true, merged: true };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      return { ok: false, error: 'Sign-in cancelled.' };
    }
    if (code === 'auth/popup-blocked') {
      return { ok: false, error: 'Your browser blocked the sign-in popup. Allow popups and retry.' };
    }
    if (code === 'auth/unauthorized-domain') {
      return {
        ok: false,
        error:
          'This domain is not authorised in Firebase. Add it under Authentication → Settings → Authorized domains.',
      };
    }
    console.warn('[auth] Google sign-in failed.', err);
    return { ok: false, error: (err as Error)?.message ?? 'Sign-in failed.' };
  }
}

/** Signs out, then signs back in anonymously so saving keeps working. */
export async function signOutUser(): Promise<void> {
  const auth = await getFirebaseAuth();
  if (!auth) return;
  try {
    const { signOut, signInAnonymously } = await import('firebase/auth');
    signingOut = true;
    await signOut(auth);
    signingOut = false;
    await signInAnonymously(auth);
  } catch (err) {
    signingOut = false;
    console.warn('[auth] Sign-out failed.', err);
  }
}

/** The current user's UID, or `null`. */
export function getUid(): string | null {
  return current.user?.uid ?? null;
}

/** A display name for the HUD: the Google name, or a friendly anonymous label. */
export function getDisplayName(): string {
  const user = current.user;
  if (!user) return 'Wanderer';
  if (user.displayName) return user.displayName;
  // Derive a stable, pleasant name from the UID for anonymous players.
  return `Wanderer ${user.uid.slice(0, 4).toUpperCase()}`;
}
