// Redirects only the device-bound imports for the timetable save test. The
// save service, `firestore.ts`, the auth profile write and the security rules
// all stay real and run against the emulators.
const stubs = new Map([
  ['@react-native-async-storage/async-storage', './stubs/async-storage-memory.mjs'],
  ['@/lib/firebase', './stubs/firebase-emulator.mjs'],
  ['@/lib/app-check', './stubs/app-check-inert.mjs'],
  ['firebase/functions', './stubs/firebase-functions-node.mjs'],
  ['react-native', './stubs/react-native-node.mjs'],
  ['expo-constants', './stubs/expo-device-inert.mjs'],
  ['expo-linking', './stubs/expo-device-inert.mjs'],
  ['expo-web-browser', './stubs/expo-device-inert.mjs'],
]);

export async function resolve(specifier, context, nextResolve) {
  const stub = stubs.get(specifier);
  if (stub) return {shortCircuit: true, url: new URL(stub, import.meta.url).href};
  return nextResolve(specifier, context);
}
