# MASTER PROMPT

## Central Multi-Vendor Inventory + 3PL + Warehouse + Shopify Management SaaS

You are the lead software architect, senior full-stack developer, database engineer, UI/UX designer, QA engineer, security engineer and technical project manager for this project.

You are responsible for planning, building, testing, documenting and deploying the complete application.

This is a real business platform, not a demo.

The final application must be:

* Reliable
* Secure
* Fast
* Simple to use
* Easy to understand
* Easy to maintain
* Cloud-based
* Responsive
* Scalable enough for future growth

Do not over-engineer.

Do not build unnecessary enterprise features.

Do not create unnecessary microservices.

Do not introduce paid services unless there is a strong business reason.

Use simple, proven architecture.

---

# 1. MOST IMPORTANT DEVELOPMENT RULE

Do NOT start coding immediately.

First enter:

## PHASE 0: PREPARATION

Read this entire prompt.

Read the existing repository.

Inspect the project structure.

Understand all requirements.

Identify missing configuration.

Identify any conflicts.

Create a clear implementation plan.

Then ask me for every required item that is genuinely necessary before implementation.

Do not ask me for information that is not needed yet.

Do not ask for future integration credentials before their phase.

Do not start building application features until I explicitly tell you to proceed.

---

# 2. REQUIRED PREPARATION INFORMATION

Before coding, determine whether the following are available.

## Firebase

Required:

* Firebase project
* Firebase web configuration
* Firebase Authentication enabled
* Authentication method required for email/password login

There is NO public user registration.

---

## Database

Use:

* PostgreSQL
* Prisma ORM

If I do not already have a PostgreSQL provider, recommend a simple reliable free-tier provider.

Do not force an unnecessarily expensive database provider.

The database must support automatic backups and restoration.

---

## Cloudinary

Required for product images:

* Cloud name
* API key
* API secret

Never expose the API secret in frontend code.

---

## Email

Only required for manual email functionality.

No automated email workflows.

If EmailJS is used, ask for its configuration only when required.

---

## GitHub

The repository should be owned by the client's company.

The repository must be private.

GitHub is the source-code/version-control system.

Never commit secrets.

---

## Vercel

The production deployment should be connected to the client's Vercel account/team.

Production environment variables must be configured securely.

---

## Shopify

Do not ask for Shopify credentials until Shopify integration development begins.

The system must support multiple Shopify stores.

---

## Accounting

The accounting application has NOT been finalized.

Do not build a specific accounting integration yet.

Only prepare the architecture and manual financial-status functionality.

---

# 3. SOURCE OF TRUTH

Create:

`PROJECT_MASTER_PROMPT.md`

and keep this prompt available inside the repository.

Create:

`/docs`

and maintain documentation throughout the project.

Create:

`/docs/DECISIONS.md`

Every important business/architecture decision must be recorded there.

Create:

`/docs/progress.md`

Keep it updated with:

* Completed
* In progress
* Pending
* Known issues
* Important testing notes

Before every major coding task:

1. Read the master prompt.
2. Read current documentation.
3. Read DECISIONS.md.
4. Read progress.md.
5. Inspect the existing code.
6. Continue from the current state.

Never rebuild working functionality without a strong reason.

---

# 4. CORE BUSINESS MODEL

The company has two major business areas.

## A. Vendor Management

The company works with many vendors.

Vendor relationships may include:

* Partnership arrangements
* Commission arrangements
* Product supply arrangements
* Other business arrangements

Products may be sold through:

* Shopify stores
* Websites
* Wholesale
* Salespeople
* Other sales channels

The system tracks products and operations related to each vendor.

---

## B. 3PL Management

Other companies can store their own products inside the company's warehouse and use the company for fulfillment.

Example:

3PL Client owns 1,000 units.

Those units are stored inside the company's warehouse.

The 3PL client receives an order from its own customer.

The 3PL client submits the fulfillment order through the platform.

Warehouse staff:

Receive order
→ Reserve stock
→ Pick
→ Pack
→ Ship
→ Track
→ Complete

The 3PL client can see its inventory and fulfillment activity through its own portal.

---

# 5. IMPORTANT DATA OWNERSHIP RULE

Every SKU belongs to exactly ONE owner.

For normal vendor products:

`SKU → Vendor`

For 3PL inventory:

`SKU → 3PL Client`

The same internal SKU must NOT belong to multiple vendors.

The database must enforce this rule.

---

# 6. USER TYPES

Support:

* Admin
* Warehouse Employee
* Salesperson
* Vendor
* 3PL Client

Do not create an unnecessarily complex permission hierarchy.

## Admin

Full platform access.

Admin can:

* Add
* Edit
* Disable
* Ban
* Reactivate
* Delete

users.

Admin can manage all business data.

## Warehouse Employee

Access warehouse operations.

## Salesperson

Access sales/order functionality appropriate for the role.

## Vendor

Own data only.

## 3PL Client

Own data only.

---

# 7. AUTHENTICATION

Use Firebase Authentication.

No public registration.

## Admin account

Admin accounts are created manually in Firebase.

Admin accounts have full administrative access.

## Vendor / 3PL accounts

Admins create these from the web application.

The account creation form should support:

* Name
* Business name
* Email
* Password
* Phone
* Address
* Contact person
* Notes
* Other useful profile information

The application should create:

1. Firebase Authentication account
2. Corresponding database profile

---

# 8. LOGIN ROUTES

Admin:

`/admin`

Vendor and 3PL:

`/user`

There is one shared user login interface.

After authentication:

Admin → Admin dashboard

Vendor → Vendor portal

3PL → 3PL portal

The system must determine the account type securely.

Role/ownership checks must also be performed server-side.

---

# 9. VENDOR PORTAL

Vendor users may only access their own information.

The portal should include:

* Products
* SKUs
* Inventory
* Inventory received
* Open orders
* Sold quantities
* Shipped quantities
* Returns
* Cancellations
* Damages
* Missing products
* Adjustments
* Reports

No vendor can access another vendor's information.

---

# 10. 3PL PORTAL

3PL users may only access their own information.

The portal should include:

* Products
* SKUs
* Current inventory
* Inventory received
* Warehouse information relevant to their products
* Orders
* Fulfillment status
* Shipments
* Tracking
* Returns
* Adjustments
* Reports

---

# 11. MULTIPLE WAREHOUSES

Support multiple warehouses.

Example:

* Warehouse A
* Warehouse B
* Warehouse C

Inventory must be tracked separately per warehouse.

Each warehouse should support locations.

Keep the location structure simple:

Warehouse
→ Zone
→ Rack
→ Shelf
→ Bin

Do not over-engineer the physical-location system.

---

# 12. PRODUCT MANAGEMENT

Products should support:

* Product name
* SKU
* Vendor/3PL ownership
* Category
* Description
* Price fields as needed
* Images
* Variants where applicable
* Status
* Internal notes where useful

The system must clearly distinguish product ownership.

---

# 13. PRODUCT IMAGES

Use Cloudinary for product images.

Support:

* Upload
* Replace
* Delete
* Multiple images where needed
* Image optimization
* Proper image URLs

Do not store large binary images directly in PostgreSQL.

---

# 14. INVENTORY ENGINE

Inventory is a core system.

DO NOT simply allow users to overwrite stock quantities.

Maintain a complete inventory movement history.

Every movement should contain:

* Product/SKU
* Vendor or 3PL client
* Warehouse
* Location where applicable
* Quantity
* Date/time
* User
* Reason
* Related order
* Related receiving record
* Related transfer if applicable

Inventory should support:

* On-hand
* Reserved
* Available

Formula conceptually:

`Available = On Hand - Reserved`

---

# 15. INVENTORY MOVEMENTS

Support:

* Receiving
* Reservation
* Reservation release
* Shipment
* Transfer
* Return
* Damage
* Missing inventory
* Manual adjustment

Examples:

`+100 Received`

`-20 Reserved`

`-20 Shipped`

`+5 Returned`

`-2 Damaged`

`-1 Missing`

`+10 Adjustment`

Every important movement must remain auditable.

---

# 16. RECEIVING

Receiving inventory should record:

* Owner
* Product/SKU
* Quantity
* Warehouse
* Location
* Date
* Employee
* Receiving reference
* Notes if needed

Inventory updates must be generated from the receiving operation.

---

# 17. INVENTORY RESERVATION

When an order requires stock, reserve it.

Example:

On-hand:

100

Reserved:

20

Available:

80

When the order is cancelled before shipment, release the appropriate reservation.

Do not create negative available stock unless explicitly supported by a future business rule.

---

# 18. INVENTORY TRANSFER

Support transfers between warehouses.

Track:

* SKU
* Quantity
* Source warehouse
* Source location
* Destination warehouse
* Destination location
* User
* Date
* Transfer status

Inventory history must show both sides.

---

# 19. DAMAGES AND MISSING INVENTORY

Support explicit event types:

### Damaged

Product is no longer available for normal sale/fulfillment.

### Missing

Product cannot be located or accounted for.

Both must be recorded with:

* Quantity
* User
* Date
* Reason
* Notes

---

# 20. AUDITED ADJUSTMENTS

An employee must not silently change inventory.

Every manual adjustment requires:

* User
* Date/time
* Quantity
* Reason
* Notes
* Before quantity
* After quantity

Keep the adjustment history permanently unless a documented business retention policy says otherwise.

---

# 21. ORDERS

The platform must support orders from:

* Manual entry
* Bulk CSV import
* Shopify

The platform is the central internal order system.

Every order should have:

* Internal order ID
* Order number
* Source
* Source reference
* Order items
* Inventory ownership
* Fulfillment information
* Shipment information
* Financial status
* History

---

# 22. MANUAL ORDER CREATION

Admin/staff should be able to create one order.

Workflow:

Create Order
→ Search/select SKU
→ Quantity
→ Warehouse
→ Validate stock
→ Create order
→ Reserve inventory

Keep the process fast.

---

# 23. BULK ORDER IMPORT

Support bulk CSV order import.

The user should be able to upload many orders.

Workflow:

Upload CSV
→ Validate columns
→ Validate values
→ Validate SKUs
→ Match products
→ Identify vendor/3PL owner
→ Check inventory
→ Create valid orders
→ Reserve inventory
→ Show errors

Show row-level errors.

Do not silently skip invalid rows.

Provide an import summary:

* Total rows
* Successful
* Failed
* Duplicate
* Inventory unavailable

Allow the user to download the failed-row report.

---

# 24. MULTI-VENDOR ORDERS

This is one of the most important database rules.

One order can contain products from multiple vendors.

Example:

Order #1001:

SKU A → Vendor A

SKU B → Vendor B

SKU C → Vendor A

SKU D → Vendor C

Customer sees:

ONE order.

Internally:

Vendor A:
SKU A
SKU C

Vendor B:
SKU B

Vendor C:
SKU D

Therefore vendor association belongs to the order item/line.

Do NOT assign only one vendor to the entire order.

---

# 25. CUSTOMER INFORMATION

Do not build a CRM.

Do not create customer accounts.

Store only the customer/order data actually required to process the order.

The system should still be capable of storing necessary shipping/contact information when required for fulfillment.

Do not build a large customer database unless the project later requires it.

---

# 26. ORDER STATUS

Keep order status separate from fulfillment status.

Suggested:

* Draft
* New
* Confirmed
* Cancelled
* Completed

---

# 27. FULFILLMENT STATUS

Suggested:

* Unfulfilled
* Reserved
* Picking
* Packed
* Partially Shipped
* Shipped
* Fulfilled

Fulfillment status should represent warehouse/order fulfillment state.

---

# 28. SHIPMENT STATUS

Suggested:

* Pending
* Shipped
* In Transit
* Delivered
* Returned

Do not combine Order Status, Fulfillment Status and Shipment Status.

They represent different concepts.

---

# 29. PARTIAL FULFILLMENT

A single order may ship in multiple parts.

Example:

Order:

Product A
Product B
Product C

Shipment 1:

A + B

Shipment 2:

C

The system must support multiple shipments for one order.

Track shipment quantities at line level.

Do not mark the entire order as shipped when only part of it has shipped.

---

# 30. PICKING

Warehouse staff should see a clear picking workflow.

Show:

* Order
* SKU
* Product
* Quantity
* Warehouse
* Location
* Quantity to pick

The system should prevent accidental double-picking.

---

# 31. PACKING

After picking, the order moves to packing.

Record that the order/fulfillment is packed.

Keep this simple.

Do not build complex packing algorithms.

---

# 32. SHIPPING

Warehouse staff can ship an order manually.

Record:

* Courier
* Shipping method
* Tracking number
* Shipment date
* Shipment status

This must work without any courier API.

---

# 33. MANUAL FULFILLMENT + SHOPIFY FULFILLMENT

The system must support two ways of receiving fulfillment information.

### Manual

Warehouse staff/admin updates:

Picking
→ Packed
→ Shipped
→ Delivered

### Shopify

Shopify can provide fulfillment information and shipment/tracking updates.

The system should synchronize applicable Shopify fulfillment information into the internal platform.

The internal application must not create duplicate fulfillments when Shopify updates are received.

Shopify's Fulfillment model can include line items, tracking data and fulfillment events, and a single order can have multiple fulfillments. Design around that rather than assuming one fulfillment per order.

---

# 34. DUPLICATE ORDER PROTECTION

This is a critical requirement.

External integrations may send the same order or event more than once.

The system must be idempotent.

Every external order/event should have a unique external identity such as:

* Shopify shop/store ID
* External order ID
* Event ID when available
* External fulfillment ID
* External update ID where available

Before creating an order, check whether that external order already exists.

Before creating an inventory movement, check whether the corresponding external event has already been applied.

Never deduct inventory twice because of a duplicate webhook or synchronization attempt.

---

# 35. ORDER MERGING / EXISTING ORDERS

When importing Shopify orders or syncing external orders:

Do NOT blindly create another internal order.

The system must attempt to match the incoming record to an existing internal order using reliable identifiers.

Primary matching should use:

1. Connected Shopify store
2. Shopify Order ID

Other references such as order number can help display/search but should not be treated as globally unique across different stores.

If an imported order already exists:

* Update/synchronize the existing internal order
* Do not create a second order
* Preserve the existing internal order ID
* Preserve internal vendor associations
* Apply only changed information
* Record the synchronization event

If no reliable match exists:

* Create one new internal order
* Store the Shopify external ID

NEVER merge two orders solely because they have a similar customer name, amount or order number.

---

# 36. SHOPIFY INTEGRATION

Shopify integration is part of the initial complete system.

Support multiple Shopify stores.

The relationship is:

Shopify Store
↔ Platform Store Connection

Do NOT assume:

`One Shopify store = One vendor`

A single Shopify store may sell products belonging to many vendors.

SKU matching determines the internal product/vendor relationship.

Example:

Shopify Store 1

SKU:

`XVS00056`

Platform:

`XVS00056 → Vendor C`

Therefore:

Shopify order
→ XVS00056
→ Internal SKU
→ Vendor C
→ Vendor C inventory

---

# 37. SHOPIFY DATA IMPORT

The platform should retrieve as much useful Shopify information as is reasonably available through the Shopify Admin API and required permissions.

For orders, where supported and permitted, retrieve relevant information such as:

* Shopify order ID
* Order number/name
* Created date
* Updated date
* Financial status
* Fulfillment status
* Line items
* SKU
* Product title
* Variant information
* Quantities
* Prices
* Discounts
* Taxes
* Shipping information
* Shipping address/contact information required for fulfillment
* Notes
* Tags
* Source/store information
* Payment-related status information exposed by Shopify
* Fulfillment information
* Fulfillment orders where applicable
* Shipment/tracking information
* Return/refund-related information where useful and available
* Relevant timestamps
* External IDs

Do not import sensitive or unnecessary data just because it exists.

Only collect data needed for business operations, reporting, synchronization and fulfillment.

Shopify's Order API is designed around the purchase lifecycle and supports order information including fulfillment and returns; use the current supported Admin GraphQL API rather than outdated REST assumptions.

---

# 38. SHOPIFY ORDER SYNC

When a Shopify order is received:

1. Identify Shopify store.
2. Identify Shopify Order ID.
3. Check whether the order already exists.
4. If it exists, synchronize it.
5. If it does not exist, create it.
6. Match every SKU.
7. Identify the internal product.
8. Identify its vendor/3PL owner.
9. Identify available inventory.
10. Create order lines.
11. Reserve inventory according to business state.
12. Save Shopify identifiers.
13. Save synchronization history.

If a SKU cannot be matched:

DO NOT guess.

Mark the synchronization as failed or needing attention.

Show the exact SKU causing the issue.

---

# 39. SHOPIFY INVENTORY SYNC

The platform must support inventory synchronization between connected Shopify stores and the central platform.

Design the architecture carefully around:

* Shopify store
* Shopify product/variant
* Shopify inventory item
* Internal SKU
* Internal warehouse
* Internal inventory quantity

Do not assume that Shopify quantity maps directly to total internal warehouse stock.

The system must have a clear rule for how available inventory is published to each Shopify store.

If a future business rule is required to split stock by store, keep the architecture flexible enough to support it.

Never randomly overwrite internal inventory based on Shopify inventory updates.

The central system must maintain an audit trail.

---

# 40. SHOPIFY INVENTORY CONFLICTS

Define synchronization direction clearly.

Internal warehouse inventory is the operational inventory source for warehouse activity.

Shopify can send order/inventory events.

When appropriate, the platform publishes calculated sellable inventory back to Shopify.

Do not allow uncontrolled two-way overwrites.

Every sync should know:

* Source
* Destination
* Operation
* Previous value
* New value
* Date/time
* Result

---

# 41. SHOPIFY FULFILLMENT SYNC

Support:

Platform
→ Shopify fulfillment update

and where Shopify exposes relevant changes:

Shopify
→ Platform fulfillment update

Support:

* Fulfillment status
* Fulfillment line items
* Quantity
* Carrier
* Tracking number
* Tracking URL
* Fulfillment date
* Relevant delivery/fulfillment events

Shopify supports multiple fulfillments for an order, including separate shipments or different locations, so the internal shipment model must also allow multiple shipments per order.

---

# 42. SHOPIFY SHIPPING / TRACKING

When the warehouse manually ships an order:

The platform records:

* Carrier
* Tracking number
* Tracking URL if available
* Shipment date
* Shipment status

For Shopify-originated orders:

Where Shopify API permissions and workflow support it, send the fulfillment/tracking information back to Shopify.

When Shopify sends tracking/fulfillment information to the platform, update the matching internal fulfillment/shipment record.

Do not create duplicate shipments.

---

# 43. SHOPIFY WEBHOOKS / EVENTS

Use Shopify webhooks/events where appropriate for near-real-time synchronization.

Do not depend only on periodic polling.

However, webhooks must be treated as notifications/events, not automatically trusted as the only source of truth.

After receiving an event:

1. Verify it.
2. Identify store.
3. Identify event/entity.
4. Check idempotency.
5. Process.
6. Record success/failure.
7. Retry safely if needed.

---

# 44. SHOPIFY SYNC LOG

Create a synchronization log.

Each record should show:

* Store
* Direction
* Entity
* External ID
* Internal ID
* Operation
* Status
* Date/time
* Error message
* Retry information

Examples:

`Shopify Store 1 → Order #5001 → Imported`

`Platform → Shopify Order #5001 → Fulfillment Updated`

`Shopify Store 2 → SKU XVS00056 → Failed: Internal SKU not found`

Make failures easy for Admin to understand.

---

# 45. SHOPIFY BULK IMPORT / EXPORT

The platform must be designed to handle large Shopify datasets efficiently.

For large reads/exports, use Shopify's current GraphQL bulk operations capabilities rather than fetching huge datasets one page at a time.

Shopify's GraphQL Admin API supports asynchronous bulk operations for large dataset queries, which return downloadable result files.

Use bulk operations where they are genuinely appropriate.

Do not use them unnecessarily for small real-time operations.

---

# 46. SHOPIFY PRODUCT IMPORT/EXPORT

The platform should provide Shopify-style product management behavior where useful.

The Admin should be able to:

* Import products
* Export products
* Import/export inventory data
* Import/export relevant order data
* Work with CSV files
* Review import errors
* See import/export history

Do not blindly clone every Shopify field.

Use the fields relevant to this business.

The UI for import/export should feel familiar and simple, similar in usability to Shopify's import/export workflow.

---

# 47. INTERNAL IMPORT / EXPORT

The platform itself should support useful data import/export.

At minimum:

* Products
* SKUs
* Inventory
* Orders
* Vendors
* 3PL clients
* Reports

CSV should be the baseline format.

Excel export should be supported where practical.

PDF should be used for reports where it makes sense.

---

# 48. REPORTING

Admin reports:

* Sales
* Orders
* Inventory
* Inventory movement
* Vendors
* Vendor activity
* 3PL activity
* Warehouses
* Fulfillment
* Shipments
* Returns
* Damages
* Missing products
* Adjustments
* Shopify synchronization
* Financial status

Vendor reports:

Own information only.

3PL reports:

Own information only.

---

# 49. FINANCIAL STATUS

Do not build accounting software.

Do not process payments.

Do not calculate vendor settlements.

Do not build vendor payouts.

For now, allow manual financial status tracking where useful:

* Not Invoiced
* Invoiced
* Paid
* Partially Paid
* Outstanding

The actual accounting software will be selected later.

Design an integration layer so accounting software can be connected later.

Do not hard-code the project around QuickBooks.

---

# 50. MANUAL EMAIL

Do not build automated notification workflows.

Admin can open:

Vendor Profile
→ Send Email

or:

3PL Profile
→ Send Email

Admin writes and sends the message.

Keep it simple.

---

# 51. AUDIT LOG

Maintain an audit history for important actions.

Examples:

* Inventory adjustment
* User creation
* User ban
* User deletion
* Order status change
* Fulfillment change
* Shipment update
* Vendor change
* 3PL change
* Shopify synchronization
* Product ownership changes

The audit log should show:

* User
* Action
* Record
* Date/time
* Important old/new values where appropriate

---

# 52. UI/UX

The UI should be much easier to understand than a traditional complex ERP.

Use a modern SaaS design.

Requirements:

* Clean
* Minimal
* Professional
* Responsive
* Fast
* Consistent
* Easy to learn

Important pages should not overwhelm users.

Use:

* Sidebar
* Breadcrumbs where useful
* Clear page headers
* Search
* Filters
* Tables
* Tabs
* Status badges
* Drawers/modals when useful
* Clear forms
* Confirmation for destructive operations
* Helpful empty states
* Helpful errors

Avoid:

* Giant forms
* Unnecessary dashboards
* Excessive charts
* Confusing terminology
* Deep navigation
* Unnecessary popups

---

# 53. SHOPIFY-LIKE IMPORT/EXPORT UX

For import/export screens, use a simple familiar workflow:

### Import

Upload file
→ Preview
→ Validate
→ Show errors
→ Confirm
→ Import
→ Results

### Export

Choose data
→ Choose filters
→ Choose format
→ Export

Provide progress indicators for large operations.

Provide downloadable error reports.

---

# 54. DASHBOARD

## Admin

Show useful information such as:

* Total products
* Total inventory
* Available inventory
* Reserved inventory
* Low stock
* Open orders
* Picking
* Packing
* Shipping
* Returns
* Vendors
* 3PL clients
* Warehouses
* Shopify sync alerts
* Recent activity

Keep it useful rather than decorative.

---

# 55. MOBILE / TABLET

The platform must work well on:

* Desktop
* Laptop
* Tablet
* Phone

Warehouse actions should remain practical on tablets.

Vendor and 3PL portals must be responsive.

---

# 56. SECURITY

Implement:

* Firebase authentication
* Server-side authorization
* Secure route protection
* Vendor data isolation
* 3PL data isolation
* Role checks
* Input validation
* Secure API handling
* Environment variables
* Audit logs

Never trust only frontend role checks.

Never allow a user to access another organization's data by changing an ID in the URL.

---

# 57. SECRETS

Never commit:

* Firebase private credentials
* Database passwords
* Cloudinary secrets
* Shopify secrets
* Accounting credentials
* Email credentials

Use:

`.env.local`

and Vercel environment variables.

Commit only:

`.env.example`

---

# 58. GITHUB

Use GitHub as the source-code repository.

The repository must be:

* Private
* Client-owned
* Version-controlled

Create commits before major changes.

Recommended checkpoints:

* Phase complete
* Major database migration
* Major integration
* Major refactor

Never perform destructive operations without a safe checkpoint.

---

# 59. DATABASE MIGRATIONS

Use Prisma migrations.

Never casually modify the production database schema manually.

Before major migrations:

* Commit code
* Review migration
* Test on development database
* Verify data safety

Do not delete production data simply to make a migration easier.

---

# 60. BACKUPS

Use a PostgreSQL provider that supports automatic backups.

Document:

* Backup frequency
* Retention
* Restore process
* Emergency recovery process

Test restoration at least once before final handover.

---

# 61. PERFORMANCE

Keep the application fast.

Use:

* Pagination
* Filtering
* Database indexes
* Efficient queries
* Lazy loading where useful
* Proper server-side operations

Do not load thousands of records into the browser unnecessarily.

Shopify large-data operations should use appropriate bulk mechanisms when necessary.

---

# 62. DEVELOPMENT PHASES

The entire initial platform should be developed in phases.

Each phase must be completed and tested before moving on.

---

## PHASE 1: FOUNDATION

Build:

* Next.js
* React
* TypeScript
* PostgreSQL
* Prisma
* Firebase Auth
* Protected routes
* User model
* Admin access
* Shared `/user` login
* Base layouts
* Navigation
* Environment handling
* Documentation foundation
* Audit-log foundation

Test:

* Admin login
* User login
* Correct portal routing
* Unauthorized access
* Database connection

---

## PHASE 2: USERS + VENDORS + 3PL CLIENTS

Build:

* Vendor management
* 3PL management
* Account creation
* User profile
* Ban/disable/delete
* Vendor portal foundation
* 3PL portal foundation
* Staff user types
* Security isolation

Test:

Vendor A cannot access Vendor B.

3PL A cannot access 3PL B.

Vendor cannot access 3PL data.

3PL cannot access Vendor data.

---

## PHASE 3: PRODUCTS + WAREHOUSES + INVENTORY

Build:

* Products
* SKUs
* Vendor ownership
* 3PL ownership
* Warehouses
* Locations
* Receiving
* Inventory ledger
* Reservations
* Transfers
* Returns
* Damages
* Missing
* Adjustments
* Audit history

Test with real-like data.

This phase must be extremely reliable.

---

## PHASE 4: ORDERS + FULFILLMENT

Build:

* Manual orders
* Bulk CSV orders
* Multi-vendor orders
* Order lines
* Vendor association
* Reservation
* Picking
* Packing
* Shipping
* Partial shipment
* Returns
* Order history

Test:

One order with products from five vendors.

Test partial shipment.

Test cancellation.

Test return.

Test duplicate order creation.

---

## PHASE 5: VENDOR PORTAL + 3PL PORTAL

Complete:

Vendor portal

and

3PL portal.

Add:

* Dashboards
* Inventory
* Orders
* Fulfillment
* Reports
* Export

Test strict ownership filtering.

---

## PHASE 6: REPORTS + IMPORT/EXPORT

Build:

* Admin reports
* Vendor reports
* 3PL reports
* Inventory reports
* Order reports
* Fulfillment reports
* Shipment reports
* CSV
* Excel
* PDF where appropriate
* Import tools
* Export tools
* Error reports

---

## PHASE 7: SHOPIFY

This phase is part of the initial 15-day development target.

Build:

* Multiple Shopify store connections
* Store configuration
* Authentication
* Order import
* SKU matching
* Inventory synchronization
* Fulfillment synchronization
* Shipment/tracking synchronization
* Webhooks/events
* Duplicate protection
* Order merging/matching
* Sync logs
* Failure logs
* Retry where practical
* Product import/export where needed
* Bulk operations where needed

Test:

### Test 1

Shopify Store A + Vendor A.

### Test 2

Shopify Store A + Vendor A + Vendor B + Vendor C.

### Test 3

Shopify Store A and Shopify Store B.

### Test 4

Same Shopify order sent multiple times.

Result:

One internal order only.

### Test 5

Unknown SKU.

Result:

Synchronization error, no incorrect inventory deduction.

### Test 6

Partial fulfillment.

Result:

Correct line-level fulfillment.

### Test 7

Tracking update.

Result:

Internal shipment updated and Shopify updated where supported.

---

## PHASE 8: FINANCIAL STATUS + ACCOUNTING READY

Build:

* Manual financial status
* Invoice reference/status fields
* Paid
* Partially Paid
* Outstanding
* Accounting integration abstraction
* Documentation for future accounting integration

Do NOT integrate a specific accounting provider until the client chooses one.

---

## PHASE 9: FINAL QA + DEPLOYMENT

Perform complete testing.

Test:

* Authentication
* Roles
* Permissions
* Vendor isolation
* 3PL isolation
* Inventory
* Orders
* Multi-vendor orders
* Partial shipments
* Returns
* Damages
* Missing stock
* Adjustments
* Bulk import
* Shopify
* Duplicate protection
* Reports
* Exports
* Backups
* Restore

Deploy production.

Verify production environment.

---

# 63. REAL BUSINESS TEST

Before declaring the first version complete, test with:

* At least one real vendor
* At least one real 3PL client
* Realistic inventory
* Realistic orders
* Realistic warehouse workflow

Do not rely only on fake demo data.

Test actual business scenarios.

---

# 64. EDGE CASES TO TEST

At minimum test:

* Duplicate Shopify webhook
* Duplicate Shopify order
* Unknown SKU
* SKU belongs to wrong vendor
* Insufficient inventory
* Order cancellation after reservation
* Partial shipment
* Multiple shipments
* Return after shipment
* Damaged return
* Missing inventory
* Warehouse transfer during order processing
* Multiple warehouses
* Same order from two Shopify stores with different store IDs
* Shopify order update after manual fulfillment
* Shopify tracking update
* Failed sync
* Retry after failure
* Vendor trying to access another vendor
* 3PL trying to access another 3PL
* Disabled account trying to log in

---

# 65. FINAL ARCHITECTURE

Conceptually:

```text
                         CENTRAL PLATFORM
                                |
          +---------------------+---------------------+
          |                     |                     |
       VENDORS              3PL CLIENTS         INTERNAL STAFF
          |                     |                     |
          +---------------------+---------------------+
                                |
                         PRODUCTS / SKUs
                                |
                       INVENTORY ENGINE
                                |
                         WAREHOUSES
                                |
                              ORDERS
                                |
                    RESERVE → PICK → PACK
                                |
                              SHIP
                                |
                     TRACKING / DELIVERY
                                |
                             REPORTS
```

External systems:

```text
Shopify Store 1 ─┐
Shopify Store 2 ─┼──→ CENTRAL PLATFORM
Shopify Store 3 ─┘
```

Future accounting:

```text
CENTRAL PLATFORM
        ↕
ACCOUNTING SOFTWARE
```

---

# 66. CORE DATABASE CONCEPT

Use a relational model.

Important entities may include:

* Users
* Vendors
* 3PL Clients
* Products
* Product Variants
* Warehouses
* Warehouse Locations
* Inventory
* Inventory Transactions
* Inventory Reservations
* Receiving Records
* Orders
* Order Items
* Fulfillments
* Fulfillment Items
* Shipments
* Shipment Items
* Returns
* Adjustments
* Reports
* Shopify Stores
* Shopify Products/Variants mappings
* Shopify Orders mappings
* Shopify Fulfillment mappings
* Shopify Sync Logs
* Financial Status
* Audit Logs

The exact schema should be designed after analyzing these requirements.

Do not create unnecessary entities.

---

# 67. CRITICAL RELATIONSHIPS

The system must conceptually support:

```text
Vendor
  ↓
Product
  ↓
SKU
  ↓
Inventory
  ↓
Warehouse
```

and:

```text
Order
  ↓
Order Item
  ↓
SKU
  ↓
Vendor / 3PL Owner
```

and:

```text
Order
  ↓
Fulfillment
  ↓
Fulfillment Items
  ↓
Shipment
```

and:

```text
Shopify Store
  ↓
Shopify Order
  ↓
Shopify Line Item
  ↓
SKU
  ↓
Internal Product
  ↓
Internal Vendor / 3PL Owner
```

This structure must be respected throughout the application.

---

# 68. FINAL UX PRINCIPLE

The technology underneath may be complex.

The interface should NOT feel complex.

A warehouse employee should be able to understand what they need to do without technical training.

An Admin should be able to find:

* Vendor
* SKU
* Order
* Inventory
* Warehouse
* Shipment

within a few clicks.

A Vendor should log in and immediately understand:

> "This is my inventory and this is what is happening with my products."

A 3PL client should log in and immediately understand:

> "This is my stock and these are the orders I asked the warehouse to fulfill."

---

# 69. FINAL OPERATING PRINCIPLE

Always prioritize:

1. Data accuracy
2. Inventory accuracy
3. Order accuracy
4. Vendor/3PL isolation
5. Shopify synchronization reliability
6. Security
7. Simplicity
8. Performance
9. Maintainability

Do not sacrifice data correctness for speed of development.

Do not sacrifice usability for technical complexity.

Do not build unnecessary features.

---

# 70. FINAL INSTRUCTION

You are now responsible for carrying this project from preparation through deployment.

However:

**DO NOT START CODING YET.**

Your first response must:

1. Confirm that you understand the entire project.
2. Summarize the architecture you intend to use.
3. Identify any conflicts or important unanswered questions.
4. List every credential/configuration/asset you need from me for the current preparation stage.
5. Tell me which information can wait until later phases.
6. Create the proposed project documentation structure.
7. Create the proposed development/implementation roadmap.

Then ask me:

**"Do you need to clarify anything else, or should I proceed with the preparation stage?"**

Do not begin actual application implementation until I explicitly tell you to proceed.
