// Loader setup for the timetable save integration test: the `@/*` alias, the
// device-only imports swapped for emulator-backed or inert stand-ins, and the
// TypeScript transform -- `auth.ts` imports the `User` type without `type`,
// which Node's own type stripping cannot drop.
import {register} from 'node:module';

process.env.TZ = 'Asia/Bangkok';

register('./ts-alias-loader.mjs', import.meta.url);
register('./scan-save-stub-loader.mjs', import.meta.url);
register('./tsx-transform-loader.mjs', import.meta.url);
