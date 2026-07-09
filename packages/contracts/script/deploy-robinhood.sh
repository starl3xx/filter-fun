#!/usr/bin/env bash
# =====================================================================================
# filter.fun — Robinhood Chain MAINNET (4663) genesis orchestrator.
#
# Chains: idempotency check → DeployGenesis.s.sol → Blockscout verification per contract.
# See docs/runbook-robinhood-deploy.md for the full cutover procedure (preflight,
# HOOK_SALT pinning, post-deploy oracle steps).
#
# Run from packages/contracts/:
#   ./script/deploy-robinhood.sh
#
# Loads `.env.robinhood` from the package root if present. Required env documented in
# DeployGenesis.s.sol's header; HOOK_SALT MUST be pre-mined via MineHookSalt against the
# release tag (this script refuses to run without it — mainnet never mines inline).
# =====================================================================================
set -euo pipefail

cd "$(dirname "$0")/.."  # cwd = packages/contracts/

ENV_FILE=".env.robinhood"
MANIFEST="deployments/robinhood.json"
VERIFIER_URL="https://robinhoodchain.blockscout.com/api/"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
else
  echo "warning: $ENV_FILE not found; relying on already-exported env vars"
fi

: "${PRIVATE_KEY:?PRIVATE_KEY required (deployer EOA)}"
: "${ROBINHOOD_RPC_URL:?ROBINHOOD_RPC_URL required (use the Alchemy URL)}"
: "${V4_POOL_MANAGER:?V4_POOL_MANAGER required (canonical: 0x8366a39cc670b4001a1121b8f6a443a643e40951)}"
: "${WETH_ADDRESS:?WETH_ADDRESS required (canonical: 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73)}"
: "${ORACLE_MULTISIG:?ORACLE_MULTISIG required (oracle signer; EOA OK at launch)}"
: "${TREASURY_PROPOSER_0:?TREASURY_PROPOSER_0 required}"
: "${TREASURY_PROPOSER_1:?TREASURY_PROPOSER_1 required}"
: "${TREASURY_PROPOSER_2:?TREASURY_PROPOSER_2 required}"
: "${MECHANICS_WALLET:?MECHANICS_WALLET required}"
: "${POL_VAULT_OWNER:?POL_VAULT_OWNER required}"
: "${HOOK_SALT:?HOOK_SALT required — mine with MineHookSalt against the release tag first}"

export DEPLOY_COMMIT_HASH="${DEPLOY_COMMIT_HASH:-$(git rev-parse HEAD)}"

# ----- Idempotency check ------------------------------------------------------------
if [[ -f "$MANIFEST" && "${FORCE_REDEPLOY:-0}" != "1" ]]; then
  prior_launcher=$(jq -r '.addresses.filterLauncher // ""' "$MANIFEST" 2>/dev/null || echo "")
  if [[ -n "$prior_launcher" && "$prior_launcher" != "0x0000000000000000000000000000000000000000" ]]; then
    echo "manifest already populated: $MANIFEST"
    echo "  prior FilterLauncher: $prior_launcher"
    echo "  set FORCE_REDEPLOY=1 to redeploy (abandon-and-redeploy is the rollback model)."
    exit 1
  fi
fi

echo "=== Step 1/2: forge script DeployGenesis (Robinhood Chain 4663) ==="
forge script script/DeployGenesis.s.sol:DeployGenesis \
  --rpc-url "$ROBINHOOD_RPC_URL" \
  --broadcast \
  --slow \
  -vvv

# ----- Verify on Blockscout -----------------------------------------------------------
echo "=== Step 2/2: Blockscout verification ==="
T=$(jq -r '.addresses.treasuryTimelock'    "$MANIFEST")
B=$(jq -r '.addresses.bonusDistributor'    "$MANIFEST")
V=$(jq -r '.addresses.polVault'            "$MANIFEST")
CP=$(jq -r '.addresses.filterClubPass'     "$MANIFEST")
L=$(jq -r '.addresses.filterLauncher'      "$MANIFEST")
M=$(jq -r '.addresses.polManager'          "$MANIFEST")
H=$(jq -r '.addresses.filterHook'          "$MANIFEST")
F=$(jq -r '.addresses.filterFactory'       "$MANIFEST")
CFD=$(jq -r '.addresses.creatorFeeDistributor' "$MANIFEST")
CC=$(jq -r '.addresses.creatorCommitments' "$MANIFEST")
CLUB_PRICE=$(jq -r '.config.filterClubMintPriceWei' "$MANIFEST")
CLUB_SUPPLY=$(jq -r '.config.filterClubMaxSupply'   "$MANIFEST")

DEPLOYER_ADDR="$(cast wallet address --private-key "$PRIVATE_KEY")"
COMMON="--verifier blockscout --verifier-url $VERIFIER_URL --watch --skip-is-verified-check"

echo "  verify TreasuryTimelock:    $T"
forge verify-contract "$T" src/TreasuryTimelock.sol:TreasuryTimelock $COMMON \
  --constructor-args "$(cast abi-encode 'constructor(address[],address[],address)' \
    "[$TREASURY_PROPOSER_0,$TREASURY_PROPOSER_1,$TREASURY_PROPOSER_2]" \
    "[$TREASURY_PROPOSER_0,$TREASURY_PROPOSER_1,$TREASURY_PROPOSER_2]" "$DEPLOYER_ADDR")"

echo "  verify BonusDistributor:    $B"
forge verify-contract "$B" src/BonusDistributor.sol:BonusDistributor $COMMON \
  --constructor-args "$(cast abi-encode 'constructor(address,address,address)' \
    "$DEPLOYER_ADDR" "$WETH_ADDRESS" "$ORACLE_MULTISIG")"

echo "  verify POLVault:            $V"
forge verify-contract "$V" src/POLVault.sol:POLVault $COMMON \
  --constructor-args "$(cast abi-encode 'constructor(address)' "$DEPLOYER_ADDR")"

echo "  verify FilterClubPass:      $CP"
forge verify-contract "$CP" src/FilterClubPass.sol:FilterClubPass $COMMON \
  --constructor-args "$(cast abi-encode 'constructor(address,address,string,uint256,uint256,uint32)' \
    "$DEPLOYER_ADDR" "${FILTER_CLUB_PAYOUT:-$T}" "${FILTER_CLUB_BASE_URI:-https://filter.fun/api/club/meta/}" \
    "$CLUB_SUPPLY" "$CLUB_PRICE" "${FILTER_CLUB_WALLET_CAP:-5}")"

echo "  verify FilterLauncher:      $L"
forge verify-contract "$L" src/FilterLauncher.sol:FilterLauncher $COMMON \
  --constructor-args "$(cast abi-encode 'constructor(address,address,address,address,address,address,address)' \
    "$DEPLOYER_ADDR" "$ORACLE_MULTISIG" "$T" "$MECHANICS_WALLET" "$B" "$WETH_ADDRESS" "$CP")"

echo "  verify POLManager:          $M"
forge verify-contract "$M" src/POLManager.sol:POLManager $COMMON \
  --constructor-args "$(cast abi-encode 'constructor(address,address,address)' \
    "$L" "$WETH_ADDRESS" "$V")"

echo "  verify FilterHook:          $H"
forge verify-contract "$H" src/FilterHook.sol:FilterHook $COMMON

echo "  verify FilterFactory:       $F"
forge verify-contract "$F" src/FilterFactory.sol:FilterFactory $COMMON \
  --constructor-args "$(cast abi-encode 'constructor(address,address,address,address,address,address,address)' \
    "$V4_POOL_MANAGER" "$H" "$L" "$WETH_ADDRESS" "$CFD" "$M" "$CC")"

echo
echo "Done. Manifest: $MANIFEST"
echo "Next (see docs/runbook-robinhood-deploy.md):"
echo "  1. polVault.acceptOwnership() from POL_VAULT_OWNER"
echo "  2. commit the manifest; sync web (NETWORK=robinhood npm run sync:deployment)"
echo "  3. flip Railway env (indexer first, then web)"
echo "  4. oracle: launcher.startSeason(); then SeedFilter; then announce the /club mint"
