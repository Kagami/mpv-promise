# mpv-promise

Promise polyfill for mpv JavaScript runtime.

## Install

```bash
npm i mpv-promise
```

## Usage with TypeScript

Example tsconfig.json:

```json
{
  "compilerOptions": {
    "lib": ["ES5", "ES2015.Promise"],
    "target": "ES5",
    "module": "ESNext",
    "moduleResolution": "node"
  }
}
```

```typescript
import "mpv-promise";

async function sleep(t: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.abs(t) || 0);
  });
}

async function main() {
  while (true) {
    await sleep(1000);
    mp.osd_message(mp.get_time());
    await sleep(500);
    mp.osd_message(mp.get_time());
  }
}

main();
```
