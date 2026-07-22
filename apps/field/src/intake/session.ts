/**
 * The app-wide {@link IntakeSession} singleton. The check-in screen and (plan
 * 005) the print path share one armed-shipment state machine; keeping it here
 * (not in component state) survives navigation away and back during a check-in
 * session and matches the Python app's single `ShipmentIntake` instance.
 */

import { IntakeSession } from "@rfid/domain";

/** Shared armed-shipment state machine for the field app. */
export const intakeSession = new IntakeSession();
