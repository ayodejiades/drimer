import { prisma } from "./db";

async function main() {
  const existing = await prisma.riskLimits.findUnique({ where: { id: 1 } });
  if (!existing) {
    await prisma.riskLimits.create({
      data: { id: 1, maxStakePerTrade: 5, maxDailyStake: 30, minEdgeThreshold: 0.05, killSwitch: false },
    });
    console.log("Seeded RiskLimits id=1");
  } else {
    console.log("RiskLimits id=1 already exists:", existing);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
