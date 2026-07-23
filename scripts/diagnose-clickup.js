/* eslint-disable no-console */
require("dotenv").config();

const token = process.env.CLICKUP_API_TOKEN;
if (!token) {
  console.error("Missing CLICKUP_API_TOKEN in .env");
  process.exit(1);
}

async function probe(label, url, headers) {
  try {
    const response = await fetch(url, { headers });
    const body = await response.text();
    console.log(`\n=== ${label} ===`);
    console.log(`URL: ${url}`);
    console.log(`Status: ${response.status}`);
    console.log(`Body: ${body.slice(0, 2000)}`);
  } catch (error) {
    console.log(`\n=== ${label} ===`);
    console.log(`URL: ${url}`);
    console.log(`Request failed: ${error.message}`);
  }
}

async function main() {
  const plain = { Authorization: token };
  const bearer = { Authorization: `Bearer ${token}` };

  await probe("v2 /user (token puro)", "https://api.clickup.com/api/v2/user", plain);
  await probe("v2 /team (token puro)", "https://api.clickup.com/api/v2/team", plain);
  await probe("v2 /team (Bearer)", "https://api.clickup.com/api/v2/team", bearer);
  await probe("v3 /workspaces (token puro)", "https://api.clickup.com/api/v3/workspaces", plain);
  await probe("v3 /workspaces (Bearer)", "https://api.clickup.com/api/v3/workspaces", bearer);
}

main();
