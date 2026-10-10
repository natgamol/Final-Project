// Inert stand-ins for the Expo modules the auth service imports at load time.
// None of them is called on the path under test (signing in is done directly
// against the emulator, not through a browser or a deep link).
export const AppOwnership = {Expo: 'expo', Guest: 'guest'};
const Constants = {appOwnership: null, executionEnvironment: 'bare', expoConfig: {}};
export default Constants;
export function createURL(path = '') { return `smartlife://${path}`; }
export function maybeCompleteAuthSession() { return {type: 'failed'}; }
export async function openAuthSessionAsync() { return {type: 'cancel'}; }
export async function openBrowserAsync() { return {type: 'cancel'}; }
