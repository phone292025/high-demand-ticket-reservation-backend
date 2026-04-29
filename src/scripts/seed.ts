import "dotenv/config";
import { DataSource } from "typeorm";
import { AppDataSource, initializeDataSource } from "../data-source";
import { Concert } from "../entities/Concert";

export const seedConcertDefinitions = [
  {
    name: "Rock Night 2026",
    venue: "Main Arena",
    startsAt: new Date("2026-08-15T20:00:00.000Z"),
    totalStock: 5,
    availableStock: 5
  },
  {
    name: "APU Live Concert",
    venue: "APU Hall",
    startsAt: new Date("2026-09-01T19:30:00.000Z"),
    totalStock: 10,
    availableStock: 10
  },
  {
    name: "VIP Acoustic Show",
    venue: "Studio Stage",
    startsAt: new Date("2026-10-10T18:00:00.000Z"),
    totalStock: 2,
    availableStock: 2
  }
];

export async function seedConcerts(dataSource: DataSource): Promise<Concert[]> {
  const concertRepository = dataSource.getRepository(Concert);
  const seededConcerts: Concert[] = [];

  for (const concertDefinition of seedConcertDefinitions) {
    let concert = await concertRepository.findOne({
      where: { name: concertDefinition.name }
    });

    if (!concert) {
      concert = concertRepository.create(concertDefinition);
    } else {
      concert.venue = concertDefinition.venue;
      concert.startsAt = concertDefinition.startsAt;
      concert.totalStock = concertDefinition.totalStock;
      concert.availableStock = concertDefinition.availableStock;
    }

    concert = await concertRepository.save(concert);
    seededConcerts.push(concert);
  }

  return seededConcerts;
}

async function run() {
  const dataSource = await initializeDataSource(AppDataSource);
  const concerts = await seedConcerts(dataSource);

  console.log("Seeded concerts:");
  for (const concert of concerts) {
    console.log(
      `- ${concert.id}: ${concert.name} (available ${concert.availableStock}/${concert.totalStock})`
    );
  }

  await dataSource.destroy();
}

if (require.main === module) {
  run().catch((error) => {
    console.error("Seed failed", error);
    process.exit(1);
  });
}
