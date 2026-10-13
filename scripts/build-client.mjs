// .env configures the local API as development. Always compile the browser
// with production React, including on Windows where shell env syntax differs.
process.env.NODE_ENV = 'production';
const { build } = await import('vite');
await build();
