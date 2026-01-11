import { ethers } from 'ethers';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const RPC_URL = ENV.RPC_URL || 'https://polygon-rpc.com';
const USDC_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;

// Contract addresses on Polygon
const CTF_CONTRACT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// Thresholds for considering a position "resolved"
const RESOLVED_HIGH = 0.99; // Position won (price ~$1)
const RESOLVED_LOW = 0.01; // Position lost (price ~$0)
const ZERO_THRESHOLD = 0.0001;

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    curPrice: number;
    title?: string;
    outcome?: string;
    slug?: string;
    redeemable?: boolean;
}

// CTF Contract ABI (only the functions we need)
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
    'function balanceOf(address owner, uint256 tokenId) external view returns (uint256)',
];

const ERC20_ABI = ['function balanceOf(address owner) external view returns (uint256)'];
const SAFE_ABI = [
    'function getOwners() public view returns (address[])',
    'function getThreshold() public view returns (uint256)',
    'function nonce() public view returns (uint256)',
    'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) public payable returns (bool success)',
];

const loadPositions = async (address: string): Promise<Position[]> => {
    const url = `https://data-api.polymarket.com/positions?user=${address}`;
    const data = await fetchData(url);
    const positions = Array.isArray(data) ? (data as Position[]) : [];
    return positions.filter((pos) => (pos.size || 0) > ZERO_THRESHOLD);
};

const normalizeConditionId = (conditionId: string): string => {
    if (/^0x[0-9a-fA-F]{64}$/.test(conditionId)) {
        return conditionId;
    }

    if (/^\d+$/.test(conditionId)) {
        return ethers.utils.hexZeroPad(
            ethers.BigNumber.from(conditionId).toHexString(),
            32
        );
    }

    throw new Error(`Invalid conditionId format: ${conditionId}`);
};

const redeemViaSafeV1 = async ({
    provider,
    ownerSigner,
    safeAddress,
    ctfAddress,
    collateral,
    conditionIdBytes32,
    indexSets,
}: {
    provider: ethers.providers.Provider;
    ownerSigner: ethers.Signer;
    safeAddress: string;
    ctfAddress: string;
    collateral: string;
    conditionIdBytes32: string;
    indexSets: number[];
}): Promise<ethers.providers.TransactionResponse> => {
    const signerAddress = await ownerSigner.getAddress();
    const safeContract = new ethers.Contract(safeAddress, SAFE_ABI, ownerSigner);
    const owners = (await safeContract.getOwners()).map((owner: string) =>
        owner.toLowerCase()
    );

    if (!owners.includes(signerAddress.toLowerCase())) {
        throw new Error('Wrong PRIVATE_KEY: signer is not an owner of the Safe');
    }

    const threshold = await safeContract.getThreshold();
    if (threshold !== 1) {
        throw new Error('Safe threshold != 1; this automation assumes 1-of-1 Safe');
    }

    const ctfInterface = new ethers.utils.Interface(CTF_ABI);
    const data = ctfInterface.encodeFunctionData('redeemPositions', [
        collateral,
        ethers.constants.HashZero,
        conditionIdBytes32,
        indexSets,
    ]);

    const nonce = await safeContract.nonce();
    const { chainId } = await provider.getNetwork();

    const safeTx = {
        to: ctfAddress,
        value: 0,
        data,
        operation: 0,
        safeTxGas: 0,
        baseGas: 0,
        gasPrice: 0,
        gasToken: ethers.constants.AddressZero,
        refundReceiver: ethers.constants.AddressZero,
        nonce,
    };

    const signature = await ownerSigner._signTypedData(
        { chainId, verifyingContract: safeAddress },
        {
            SafeTx: [
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'data', type: 'bytes' },
                { name: 'operation', type: 'uint8' },
                { name: 'safeTxGas', type: 'uint256' },
                { name: 'baseGas', type: 'uint256' },
                { name: 'gasPrice', type: 'uint256' },
                { name: 'gasToken', type: 'address' },
                { name: 'refundReceiver', type: 'address' },
                { name: 'nonce', type: 'uint256' },
            ],
        },
        safeTx
    );

    const tx = await safeContract.execTransaction(
        safeTx.to,
        safeTx.value,
        safeTx.data,
        safeTx.operation,
        safeTx.safeTxGas,
        safeTx.baseGas,
        safeTx.gasPrice,
        safeTx.gasToken,
        safeTx.refundReceiver,
        signature
    );

    await tx.wait();

    const sent = await provider.getTransaction(tx.hash);
    if (sent?.to?.toLowerCase() !== safeAddress.toLowerCase()) {
        throw new Error("BUG: not a Safe execTransaction tx (wrong 'to')");
    }

    return tx;
};

const redeemPosition = async (
    provider: ethers.providers.Provider,
    ownerSigner: ethers.Signer,
    position: Position
): Promise<{ success: boolean; error?: string }> => {
    try {
        // Convert conditionId to bytes32 format
        const conditionIdBytes32 = normalizeConditionId(position.conditionId);

        // indexSets: [1, 2] represents both outcome collections
        // We use [1, 2] to redeem all positions for this condition
        const indexSets = [1, 2];

        console.log(`   Attempting redemption...`);
        console.log(`   Condition ID: ${conditionIdBytes32}`);
        console.log(`   Index Sets: [${indexSets.join(', ')}]`);

        const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
        const balanceBefore = await usdcContract.balanceOf(PROXY_WALLET);

        const tx = await redeemViaSafeV1({
            provider,
            ownerSigner,
            safeAddress: PROXY_WALLET,
            ctfAddress: CTF_CONTRACT_ADDRESS,
            collateral: USDC_ADDRESS,
            conditionIdBytes32,
            indexSets,
        });

        console.log(`   ⏳ Transaction submitted: ${tx.hash}`);
        console.log(`   ✅ Redemption confirmed via Safe execTransaction`);

        const balanceAfter = await usdcContract.balanceOf(PROXY_WALLET);
        const delta = balanceAfter.sub(balanceBefore);
        console.log(
            `   💵 Safe USDC balance delta: ${ethers.utils.formatUnits(delta, 6)}`
        );
        if (delta.isZero()) {
            console.log(
                '   ⚠️  WARNING: USDC balance did not increase. Check if position was a winner.'
            );
        }

        return { success: true };
    } catch (error: any) {
        const errorMessage = error.message || String(error);
        console.log(`   ❌ Redemption failed: ${errorMessage}`);
        return { success: false, error: errorMessage };
    }
};

const logPositionHeader = (position: Position, index: number, total: number) => {
    const status = position.curPrice >= RESOLVED_HIGH ? '🎉 WIN' : '❌ LOSS';
    console.log(
        `\n${index + 1}/${total} ▶ ${status} | ${position.title || position.slug || position.asset}`
    );
    if (position.outcome) {
        console.log(`   Outcome: ${position.outcome}`);
    }
    console.log(`   Size: ${position.size.toFixed(2)} tokens`);
    console.log(`   Current price: $${position.curPrice.toFixed(4)}`);
    console.log(`   Expected value: $${position.currentValue.toFixed(2)}`);
    console.log(`   Redeemable: ${position.redeemable ? 'YES' : 'NO'}`);
};

const main = async () => {
    console.log('🚀 Redeeming resolved positions');
    console.log('════════════════════════════════════════════════════');
    console.log(`Wallet: ${PROXY_WALLET}`);
    console.log(`CTF Contract: ${CTF_CONTRACT_ADDRESS}`);
    console.log(`Win threshold: price >= $${RESOLVED_HIGH}`);
    console.log(`Loss threshold: price <= $${RESOLVED_LOW}`);

    // Setup provider and signer
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    console.log(`\n✅ Connected to Polygon RPC`);
    console.log(`Signer address: ${wallet.address}`);

    // Check if signer is proxy wallet or owner
    if (wallet.address.toLowerCase() !== PROXY_WALLET.toLowerCase()) {
        console.log(
            `ℹ️  Expected: signer is EOA owner; redemption executed via Safe proxy.`
        );
    }

    // Load positions
    const allPositions = await loadPositions(PROXY_WALLET);

    if (allPositions.length === 0) {
        console.log('\n🎉 No open positions detected for proxy wallet.');
        return;
    }

    const includeLosers = process.env.REDEEM_LOSERS === 'true';

    // Filter for resolved and redeemable positions
    const redeemablePositions = allPositions.filter((pos) => {
        if (pos.redeemable !== true) {
            return false;
        }

        if (pos.curPrice >= RESOLVED_HIGH) {
            return true;
        }

        return includeLosers && pos.curPrice <= RESOLVED_LOW;
    });

    const activePositions = allPositions.filter(
        (pos) => pos.curPrice > RESOLVED_LOW && pos.curPrice < RESOLVED_HIGH
    );

    console.log(`\n📊 Position statistics:`);
    console.log(`   Total positions: ${allPositions.length}`);
    console.log(`   ✅ Resolved and redeemable: ${redeemablePositions.length}`);
    console.log(`   ⏳ Active (not touching): ${activePositions.length}`);

    if (redeemablePositions.length === 0) {
        console.log('\n✅ No positions to redeem.');
        return;
    }

    console.log(`\n🔄 Redeeming ${redeemablePositions.length} positions...`);
    console.log(`⚠️  WARNING: Each redemption requires gas fees on Polygon`);

    let successCount = 0;
    let failCount = 0;
    let totalValue = 0;

    // Group positions by conditionId to avoid duplicate redemptions
    const positionsByCondition = new Map<string, Position[]>();
    redeemablePositions.forEach((pos) => {
        const existing = positionsByCondition.get(pos.conditionId) || [];
        existing.push(pos);
        positionsByCondition.set(pos.conditionId, existing);
    });

    console.log(
        `\n📦 Grouped into ${positionsByCondition.size} unique conditions`
    );

    let conditionIndex = 0;
    for (const [conditionId, positions] of positionsByCondition.entries()) {
        conditionIndex++;
        const totalPositionValue = positions.reduce((sum, pos) => sum + pos.currentValue, 0);

        console.log(`\n${'='.repeat(60)}`);
        console.log(`Condition ${conditionIndex}/${positionsByCondition.size}`);
        console.log(`Condition ID: ${conditionId}`);
        console.log(`Positions in this condition: ${positions.length}`);
        console.log(`Total expected value: $${totalPositionValue.toFixed(2)}`);

        // Show all positions for this condition
        positions.forEach((pos, idx) => {
            const status = pos.curPrice >= RESOLVED_HIGH ? '🎉' : '❌';
            console.log(
                `   ${status} ${pos.title || pos.slug} | ${pos.outcome} | ${pos.size.toFixed(2)} tokens | $${pos.currentValue.toFixed(2)}`
            );
        });

        // Redeem once for this condition (redeems all positions)
        const result = await redeemPosition(provider, wallet, positions[0]);

        if (result.success) {
            successCount++;
            totalValue += totalPositionValue;
        } else {
            failCount++;
        }

        // Small delay between transactions
        if (conditionIndex < positionsByCondition.size) {
            console.log(`   ⏳ Waiting 2s before next transaction...`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }

    console.log('\n════════════════════════════════════════════════════');
    console.log('✅ Summary of position redemption');
    console.log(`Conditions processed: ${positionsByCondition.size}`);
    console.log(`Successful redemptions: ${successCount}`);
    console.log(`Failed: ${failCount}`);
    console.log(`Expected value of redeemed positions: $${totalValue.toFixed(2)}`);
    console.log('════════════════════════════════════════════════════\n');
};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Script aborted due to error:', error);
        process.exit(1);
    });
