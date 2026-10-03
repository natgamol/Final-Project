import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createUserWithEmailAndPassword,
  deleteUser,
  FacebookAuthProvider,
  getIdTokenResult,
  GoogleAuthProvider,
  sendPasswordResetEmail,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  User,
} from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import {demoUid, hasFirebaseConfig, hasRealPublicConfigValue, isDemoMode} from '@/lib/demo-mode';
import { auth, db } from '@/lib/firebase';
import {isExpoGo} from '@/lib/expo-runtime';
import { clearGoogleCalendarSession } from '@/services/google-calendar';

export type AppRole = 'user' | 'admin';

type RegisterInput = {
  displayName: string;
  email: string;
  password: string;
};

const demoUser = {
  displayName: 'SmartLife Demo',
  email: 'demo@smartlife.local',
  uid: demoUid,
} as User;

// OAuth client IDs are public identifiers. This Firebase project's web OAuth
// client is kept as a safe fallback so native Google Sign-In remains usable
// when a teammate has not copied the optional value into .env.local yet.
const FIREBASE_GOOGLE_WEB_CLIENT_ID = '302211453614-ui2mf0hqknu0itr8r4g76g1odrfhc6fe.apps.googleusercontent.com';

function requireFirebaseConfig() {
  if (!hasFirebaseConfig) {
    throw new Error('ยังไม่ได้ตั้งค่า Firebase ของโปรเจกต์จริงครับ กรุณาใส่ค่า Firebase config ของ smartlife-budget ในไฟล์ .env.local แล้ว restart แอป');
  }
}

function googleWebClientId() {
  const configured = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim();
  return hasRealPublicConfigValue(configured) ? configured : FIREBASE_GOOGLE_WEB_CLIENT_ID;
}

export async function registerWithEmail({ displayName, email, password }: RegisterInput) {
  if (isDemoMode) return {...demoUser, displayName: displayName || demoUser.displayName, email} as User;
  requireFirebaseConfig();
  const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);

  try {
    await updateProfile(credential.user, { displayName: displayName.trim() });
    await setDoc(doc(db, 'users', credential.user.uid), {
      uid: credential.user.uid,
      email: credential.user.email,
      displayName: displayName.trim(),
      avatarUrl: '',
      consentHistory: [{changedAt: new Date(), method: 'onboarding', tier: 'manual_only'}],
      consentTier: 'manual_only',
      lineConsentUpdatedAt: serverTimestamp(),
      lineConsentVersion: 1,
      lineListenerStatus: 'not_applicable',
      role: 'user',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    await deleteUser(credential.user);
    throw error;
  }

  return credential.user;
}

export async function signInWithEmail(email: string, password: string) {
  if (isDemoMode) return {...demoUser, email} as User;
  requireFirebaseConfig();
  const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
  return credential.user;
}

function logGoogleLoginConfiguration() {
  if (!__DEV__) return;
  const webClientId = googleWebClientId();
  const androidClientId = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID?.trim();
  console.info('[Google Login] OAuth environment', {
    androidClientIdLoaded: hasRealPublicConfigValue(androidClientId),
    platform: Platform.OS,
    webClientIdLoaded: Boolean(webClientId),
    webClientProject: webClientId?.split('-')[0] ?? '<missing>',
  });
}

async function createSocialUserProfile(user: User) {
  await ensureUserProfile(user);
}

export async function ensureUserProfile(user = auth.currentUser) {
  // Demo mode has no signed-in user and writes nothing to Firestore; every
  // save path in it stops at this check otherwise.
  if (isDemoMode) return;
  if (!user) {
    throw new Error('กรุณาเข้าสู่ระบบก่อนบันทึกข้อมูล');
  }

  const reference = doc(db, 'users', user.uid);
  if ((await getDoc(reference)).exists()) return;

  await setDoc(reference, {
    uid: user.uid,
    email: user.email ?? '',
    displayName: user.displayName?.trim() || user.email?.split('@')[0] || 'ผู้ใช้ SmartLife',
    avatarUrl: user.photoURL?.startsWith('https://') ? user.photoURL : '',
    consentHistory: [{changedAt: new Date(), method: 'onboarding', tier: 'manual_only'}],
    consentTier: 'manual_only',
    lineConsentUpdatedAt: serverTimestamp(),
    lineConsentVersion: 1,
    lineListenerStatus: 'not_applicable',
    role: 'user',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

function parseOAuthCallbackParams(url: string) {
  const fragment = url.includes('#') ? url.split('#')[1] : '';
  const query = url.includes('?') ? url.split('?')[1]?.split('#')[0] ?? '' : '';
  return new URLSearchParams(fragment || query);
}

export async function signInWithGoogle() {
  if (isDemoMode) return demoUser;
  requireFirebaseConfig();
  logGoogleLoginConfiguration();
  let user: User;

  if (Platform.OS === 'web') {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({prompt: 'select_account'});
    user = (await signInWithPopup(auth, provider)).user;
  } else {
    if (isExpoGo()) {
      throw new Error('Google Login บนมือถือใช้ไม่ได้ใน Expo Go กรุณาเปิดด้วย SmartLife development build');
    }

    const webClientId = googleWebClientId();

    try {
      const {GoogleSignin, isSuccessResponse} = await import('@react-native-google-signin/google-signin');
      GoogleSignin.configure({offlineAccess: false, webClientId});
      await GoogleSignin.hasPlayServices({showPlayServicesUpdateDialog: true});
      let response = GoogleSignin.hasPreviousSignIn()
        ? await GoogleSignin.signInSilently()
        : await GoogleSignin.signIn();
      if (response.type === 'noSavedCredentialFound') response = await GoogleSignin.signIn();
      if (!isSuccessResponse(response)) throw new Error('ยกเลิกการเข้าสู่ระบบด้วย Google');
      if (!response.data.idToken) throw new Error('Google ไม่ได้ส่ง ID token กลับมา');

      const credential = GoogleAuthProvider.credential(response.data.idToken);
      user = (await signInWithCredential(auth, credential)).user;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/native module|null|TurboModule|RNGoogleSignin/i.test(message)) {
        throw new Error('Google Login ต้องเปิดด้วย SmartLife development build ไม่รองรับ Expo Go');
      }
      if (/DEVELOPER_ERROR|code.?10/i.test(message)) {
        throw new Error('ลายเซ็น APK ยังไม่ตรงกับ Firebase กรุณาติดตั้ง SmartLife APK รุ่นล่าสุด');
      }
      throw error;
    }
  }

  await createSocialUserProfile(user);
  return user;
}

export async function signInWithFacebook() {
  if (isDemoMode) return demoUser;
  requireFirebaseConfig();
  let user: User;

  if (Platform.OS === 'web') {
    const provider = new FacebookAuthProvider();
    provider.addScope('email');
    user = (await signInWithPopup(auth, provider)).user;
  } else {
    if (isExpoGo()) {
      throw new Error('Facebook Login ต้องเปิดด้วย SmartLife development build ไม่รองรับ Expo Go');
    }

    const appId = process.env.EXPO_PUBLIC_FACEBOOK_APP_ID?.trim();
    if (!appId) throw new Error('ยังไม่ได้ตั้งค่า EXPO_PUBLIC_FACEBOOK_APP_ID ใน .env.local');

    const redirectUri = Linking.createURL('auth/facebook');
    const state = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const loginUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent('public_profile,email')}&state=${encodeURIComponent(state)}`;
    const result = await WebBrowser.openAuthSessionAsync(loginUrl, redirectUri);
    if (result.type !== 'success') throw new Error('ยกเลิกการเข้าสู่ระบบด้วย Facebook');

    const params = parseOAuthCallbackParams(result.url);
    if (params.get('state') !== state) throw new Error('Facebook Login ถูกปฏิเสธเพราะ state ไม่ตรงกัน');
    const error = params.get('error_description') ?? params.get('error_message') ?? params.get('error');
    if (error) throw new Error(error);
    const accessToken = params.get('access_token');
    if (!accessToken) throw new Error('Facebook ไม่ได้ส่ง access token กลับมา');

    const credential = FacebookAuthProvider.credential(accessToken);
    user = (await signInWithCredential(auth, credential)).user;
  }

  await createSocialUserProfile(user);
  return user;
}

export async function sendResetEmail(email: string) {
  if (isDemoMode) return;
  requireFirebaseConfig();
  await sendPasswordResetEmail(auth, email.trim());
}

export async function signOutCurrentUser() {
  if (!isDemoMode && hasFirebaseConfig) await signOut(auth);
  await Promise.allSettled([
    AsyncStorage.removeItem('smartlife:last-ocr:receipt'),
    AsyncStorage.removeItem('smartlife:last-ocr:schedule'),
    clearGoogleCalendarSession(),
  ]);
}

/**
 * The two profile fields the user can change after registering.
 *
 * Each one lives in two places: Firebase Auth, which is what `displayName` and
 * `photoURL` mean to the rest of the SDK, and the `users/{uid}` document, which
 * is what the screens actually read through `loadLegacyPageData`. Writing only
 * one of them leaves the app showing the old value, so both move together here
 * rather than at each call site.
 *
 * The Firestore rule for this document accepts a change to `displayName`,
 * `avatarUrl` and `updatedAt` and nothing else, and requires a name of 1-80
 * characters and an avatar that is empty or an https URL. Both are checked
 * before the write so a rejection surfaces as a readable message rather than a
 * bare permission error.
 */
export async function updateProfileDetails({avatarUrl, displayName, studentId}: {avatarUrl?: string; displayName?: string; studentId?: string}) {
  if (isDemoMode) return;
  requireFirebaseConfig();
  const user = auth.currentUser;
  if (!user) throw new Error('กรุณาเข้าสู่ระบบก่อนแก้ไขโปรไฟล์');

  const name = displayName?.trim();
  if (displayName !== undefined) {
    if (!name) throw new Error('กรุณากรอกชื่อที่แสดง');
    if (name.length > 80) throw new Error('ชื่อที่แสดงต้องยาวไม่เกิน 80 ตัวอักษร');
  }
  if (avatarUrl !== undefined && avatarUrl !== '' && !avatarUrl.startsWith('https://')) {
    throw new Error('ลิงก์รูปโปรไฟล์ไม่ถูกต้อง');
  }
  // Optional: an empty string is how it is cleared, so only the length is
  // checked. It is not a login identifier and nothing requires it.
  const student = studentId?.trim();
  if (student !== undefined && student.length > 32) throw new Error('รหัสนักศึกษาต้องยาวไม่เกิน 32 ตัวอักษร');

  // Firebase Auth has no field for a student ID -- it lives only on the users
  // document -- so a change to it alone skips the Auth round trip.
  if (name !== undefined || avatarUrl !== undefined) {
    await updateProfile(user, {
      ...(name === undefined ? {} : {displayName: name}),
      ...(avatarUrl === undefined ? {} : {photoURL: avatarUrl}),
    });
  }
  await updateDoc(doc(db, 'users', user.uid), {
    ...(name === undefined ? {} : {displayName: name}),
    ...(avatarUrl === undefined ? {} : {avatarUrl}),
    ...(student === undefined ? {} : {studentId: student}),
    updatedAt: serverTimestamp(),
  });
}

export async function getUserRole(user: User): Promise<AppRole> {
  if (isDemoMode) return 'user';
  requireFirebaseConfig();
  const token = await getIdTokenResult(user, true);
  return token.claims.admin === true ? 'admin' : 'user';
}
