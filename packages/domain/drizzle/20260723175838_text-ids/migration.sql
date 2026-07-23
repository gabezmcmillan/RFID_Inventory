PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_bol_docs` (
	`id` text PRIMARY KEY,
	`bol_number` text NOT NULL,
	`filename` text NOT NULL,
	`source` text DEFAULT 'scan' NOT NULL,
	`pages` integer DEFAULT 1 NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`po_number` text DEFAULT '' NOT NULL,
	`ocr_text` text DEFAULT '' NOT NULL,
	`line_items` text DEFAULT '[]' NOT NULL,
	`auto_named` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`storage_url` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_bol_docs`(`id`, `bol_number`, `filename`, `source`, `pages`, `vendor`, `po_number`, `ocr_text`, `line_items`, `auto_named`, `created_at`, `storage_url`) SELECT `id`, `bol_number`, `filename`, `source`, `pages`, `vendor`, `po_number`, `ocr_text`, `line_items`, `auto_named`, `created_at`, `storage_url` FROM `bol_docs`;--> statement-breakpoint
DROP TABLE `bol_docs`;--> statement-breakpoint
ALTER TABLE `__new_bol_docs` RENAME TO `bol_docs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` text PRIMARY KEY,
	`ts` text NOT NULL,
	`action` text NOT NULL,
	`epc` text,
	`item_type` text,
	`bol_number` text,
	`building` text,
	`vendor` text,
	`detail` text
);
--> statement-breakpoint
INSERT INTO `__new_events`(`id`, `ts`, `action`, `epc`, `item_type`, `bol_number`, `building`, `vendor`, `detail`) SELECT `id`, `ts`, `action`, `epc`, `item_type`, `bol_number`, `building`, `vendor`, `detail` FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notes` (
	`id` text PRIMARY KEY,
	`ts` text NOT NULL,
	`item_type` text NOT NULL,
	`bol_number` text DEFAULT '' NOT NULL,
	`building` text DEFAULT '' NOT NULL,
	`text` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_notes`(`id`, `ts`, `item_type`, `bol_number`, `building`, `text`) SELECT `id`, `ts`, `item_type`, `bol_number`, `building`, `text` FROM `notes`;--> statement-breakpoint
DROP TABLE `notes`;--> statement-breakpoint
ALTER TABLE `__new_notes` RENAME TO `notes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tags` (
	`id` text PRIMARY KEY,
	`epc` text NOT NULL UNIQUE,
	`item_type` text NOT NULL,
	`item_name` text DEFAULT '' NOT NULL,
	`bol_number` text DEFAULT '' NOT NULL,
	`po_number` text DEFAULT '' NOT NULL,
	`building` text DEFAULT '' NOT NULL,
	`sector` text DEFAULT '' NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`sku` text DEFAULT '' NOT NULL,
	`mfc_date` text DEFAULT '' NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`remaining` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'In Warehouse' NOT NULL,
	`received_at` text NOT NULL,
	`delivered_at` text DEFAULT '' NOT NULL,
	`checkout_building` text DEFAULT '' NOT NULL,
	`flag` text DEFAULT '' NOT NULL,
	`flagged_at` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`bol_doc_id` text
);
--> statement-breakpoint
INSERT INTO `__new_tags`(`id`, `epc`, `item_type`, `item_name`, `bol_number`, `po_number`, `building`, `sector`, `vendor`, `sku`, `mfc_date`, `quantity`, `remaining`, `status`, `received_at`, `delivered_at`, `checkout_building`, `flag`, `flagged_at`, `created_at`, `updated_at`, `bol_doc_id`) SELECT `id`, `epc`, `item_type`, `item_name`, `bol_number`, `po_number`, `building`, `sector`, `vendor`, `sku`, `mfc_date`, `quantity`, `remaining`, `status`, `received_at`, `delivered_at`, `checkout_building`, `flag`, `flagged_at`, `created_at`, `updated_at`, `bol_doc_id` FROM `tags`;--> statement-breakpoint
DROP TABLE `tags`;--> statement-breakpoint
ALTER TABLE `__new_tags` RENAME TO `tags`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_events_action` ON `events` (`action`);--> statement-breakpoint
CREATE INDEX `idx_events_epc` ON `events` (`epc`);--> statement-breakpoint
CREATE INDEX `idx_notes_group` ON `notes` (`item_type`,`bol_number`,`building`);--> statement-breakpoint
CREATE INDEX `idx_tags_group` ON `tags` (`item_type`,`bol_number`,`building`);--> statement-breakpoint
CREATE INDEX `idx_tags_status` ON `tags` (`status`);