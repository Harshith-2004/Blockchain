// test_mock_oracle.js
// Dependencies: ethers@5, solc
// Run: node test_mock_oracle.js

const { ethers } = require("ethers");
const fs       = require("fs");
const solc     = require("solc");

async function main() {
  // ─── 1) Load & compile the two contracts ──────────────────────────────
  const files = ["MockV3Aggregator.sol", "PeggedToken.sol"];
  const sources = {};
  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`${f} not found`);
    sources[f] = fs.readFileSync(f, "utf8");
  }
  const input = {
    language: "Solidity",
    sources: Object.fromEntries(
      Object.entries(sources).map(([fn,content])=>[fn,{content}])
    ),
    settings: { outputSelection: { "*": { "*": ["abi","evm.bytecode"] } } }
  };
  function findImports(path) {
    const key = path.replace("./","");
    return sources[key] ? { contents: sources[key] } : { error: "File not found" };
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  if (output.errors) for (const e of output.errors) if (e.severity === "error") throw new Error(e.formattedMessage);

  const C = (name, fn) => output.contracts[fn][name];

  // ─── 2) Connect to local Ganache ───────────────────────────────────────
  const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");
  const [deployer] = await provider.listAccounts();
  const signer = provider.getSigner(deployer);

  // ─── 3) Deploy MockV3Aggregator at $1.00 (1e8) ──────────────────────────
  console.log("Deploying MockV3Aggregator at 1.00...");
  const Mock = await new ethers.ContractFactory(
    C("MockV3Aggregator","MockV3Aggregator.sol").abi,
    C("MockV3Aggregator","MockV3Aggregator.sol").evm.bytecode.object,
    signer
  ).deploy(ethers.BigNumber.from("100000000"));
  await Mock.deployed();

  // Quick check: latestRoundData
  let price = await Mock.latestRoundData().then(r=>r[1]);
  console.log(" → initial price:", price.toString()); // should be 100000000

  // ─── 4) Deploy PeggedToken pointing at the mock ─────────────────────────
  console.log("Deploying PeggedToken...");
  const Pegged = await new ethers.ContractFactory(
    C("PeggedToken","PeggedToken.sol").abi,
    C("PeggedToken","PeggedToken.sol").evm.bytecode.object,
    signer
  ).deploy(Mock.address);
  await Pegged.deployed();

  // Check initial supply & balance
  let total = await Pegged.totalSupply();
  let bal   = await Pegged.balanceOf(deployer);
  console.log(` → totalSupply=${ethers.utils.formatUnits(total,18)}, deployerBal=${ethers.utils.formatUnits(bal,18)}`);

  // ─── 5) Verify getPegPrice on the token ────────────────────────────────
  let peg0 = await Pegged.getPegPrice();
  console.log("PeggedToken sees price:", peg0.toString()); // 1e8

  // ─── 6) Simulate a price spike to $1.20 ────────────────────────────────
  console.log("Simulating price spike to 1.20...");
  await Mock.updateAnswer(ethers.BigNumber.from("120000000"));
  let peg1 = await Pegged.getPegPrice();
  console.log(" → new feed price:", peg1.toString());

  // ─── 7) Call adjustSupply() (should mint 1 token to signer) ───────────
  const balBeforeMint = await Pegged.balanceOf(deployer);
  await Pegged.adjustSupply();
  const balAfterMint  = await Pegged.balanceOf(deployer);
  console.log(" → minted:", balAfterMint.sub(balBeforeMint).toString(), "wei");

  // Confirm exactly 1e18 (one token) minted
  if (!balAfterMint.sub(balBeforeMint).eq(ethers.utils.parseUnits("1",18))) {
    throw new Error("Mint amount mismatch");
  }

  // ─── 8) Simulate a crash to $0.80 ───────────────────────────────────────
  console.log("Simulating price crash to 0.80...");
  await Mock.updateAnswer(ethers.BigNumber.from("80000000"));
  let peg2 = await Pegged.getPegPrice();
  console.log(" → new feed price:", peg2.toString());

  // ─── 9) Call adjustSupply() (should burn 1 token) ────────────────────
  const balBeforeBurn = await Pegged.balanceOf(deployer);
  await Pegged.adjustSupply();
  const balAfterBurn  = await Pegged.balanceOf(deployer);
  console.log(" → burned:", balBeforeBurn.sub(balAfterBurn).toString(), "wei");

  if (!balBeforeBurn.sub(balAfterBurn).eq(ethers.utils.parseUnits("1",18))) {
    throw new Error("Burn amount mismatch");
  }

  console.log("\n🎉 Mock Oracle + PeggedToken tests passed!");
}

main().catch(e=>{
  console.error("❌ Test failed:", e);
  process.exit(1);
});
