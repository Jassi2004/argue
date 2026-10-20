#!/usr/bin/env node
const [major] = process.versions.node.split(".").map(Number);
if (major < 20) {
  console.error(`argue needs Node.js 20 or newer (you have ${process.versions.node}). https://nodejs.org`);
  process.exit(1);
}
const { main } = await import("../src/cli/index.js");
main(process.argv.slice(2)).catch((err) => {
  console.error(`argue: ${err.message}`);
  process.exit(1);
});
