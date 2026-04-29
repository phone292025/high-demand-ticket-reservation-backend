import "dotenv/config";
import { AppDataSource, initializeDataSource } from "../data-source";
import { Concert } from "../entities/Concert";
import { Ticket } from "../entities/Ticket";
import { ReservationService } from "../services/reservation.service";

const proofConcertName = "Rollback Proof Concert";

async function run() {
  const dataSource = await initializeDataSource(AppDataSource);
  await dataSource.runMigrations();

  const concertRepository = dataSource.getRepository(Concert);
  const ticketRepository = dataSource.getRepository(Ticket);

  let concert = await concertRepository.findOne({
    where: { name: proofConcertName }
  });

  if (!concert) {
    concert = concertRepository.create({
      name: proofConcertName,
      venue: "Test Hall",
      startsAt: new Date("2026-12-31T20:00:00.000Z"),
      totalStock: 1,
      availableStock: 1
    });
  } else {
    concert.totalStock = 1;
    concert.availableStock = 1;
  }

  concert = await concertRepository.save(concert);

  console.log(`Before reserve: availableStock = ${concert.availableStock}`);
  console.log("Stock will be decreased inside a transaction.");

  try {
    await new ReservationService(dataSource).reserveTicket(
      {
        concertId: concert.id,
        userId: "rollback_proof_user"
      },
      { forceTicketSaveFailure: true }
    );
  } catch (error) {
    console.log("Ticket save failed intentionally.");
    console.log(`Failure: ${(error as Error).message}`);
    console.log("Transaction rolled back.");
  }

  const afterRollback = await concertRepository.findOneByOrFail({
    id: concert.id
  });
  const proofTickets = await ticketRepository.count({
    where: {
      concertId: concert.id,
      userId: "rollback_proof_user"
    }
  });

  console.log(`After rollback: availableStock = ${afterRollback.availableStock}`);
  console.log(`Proof tickets saved: ${proofTickets}`);

  await concertRepository.delete({ id: concert.id });
  await dataSource.destroy();
}

run().catch((error) => {
  console.error("Rollback proof failed", error);
  process.exit(1);
});
