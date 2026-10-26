import { createMemoryTeamsWorkStore } from "../../src/teams/store/memory.js";
import { teamsStoreContract } from "../shared/teamsStoreContract.js";

teamsStoreContract("Teams memory store", (now) => createMemoryTeamsWorkStore({ now }));
