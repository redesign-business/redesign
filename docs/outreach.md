# Cold email outreach

## Exact problem

The current bottleneck is distribution: completed redesigns exist, but prospects have not seen them. The immediate goal is to learn whether showing finished redesigns to relevant businesses produces positive replies and sales.

Do not optimize for a future high-volume sales organization before this is proven. The first milestone is one positive reply.

## Initial experiment

- Start with roughly 100 custom home builders around Incline Village found through Google Maps and organic search.
- Target businesses that already have a website, whose customers use that website when deciding whether to make contact, and whose current website undersells otherwise credible work.
- Use the five pre-warmed Instantly inboxes already purchased, ramp sending cautiously, and learn from the first batch before increasing volume.
- Track delivery, redesign-preview visits, replies, positive replies, sales, and revenue so the next bottleneck comes from evidence.

The hypothesis is not that every small business needs a better website. It is that some businesses with existing demand lose qualified customers because their website underperforms, and that a finished redesign makes the value of improving it concrete.

## Prospect generation

Use one narrow discovery query: `{business category} in {local area}`. Run it through the official Google Places Text Search API rather than scraping the Google Maps interface. Geography, business activity, and website quality are the relevant selection signals. A valid email is a contactability check, not proof that the business is a good prospect or that the recipient represents the business.

For future batches, use this order:

1. Discover an active business in the target category and geography.
2. Store the Google listing, then group listings that resolve to the same website into one business prospect.
3. Confirm that it has an existing website that undersells credible work.
4. Find a public contact route: a published business email or a working contact form.
5. If an email is found, confirm that it belongs to the business and verify it with Instantly's standalone verifier. Treat both ordinary and catch-all addresses as eligible when Instantly reports `verified`; stop on `invalid`.
6. If neither route exists, stop. Do not spend money creating a redesign that cannot be delivered.
7. Create the redesign preview and its proof sentences.
8. Send verified-email prospects through Instantly. Submit contact-form-only prospects with a browser running in a Vercel Sandbox.

The discovery command stores every Google Places result by place ID, including businesses without a website. It adaptively subdivides the requested area's bounds when a search cell reaches Google's 60-result ceiling, then deduplicates the combined results. The repository already extracts and stores public emails and contact-form URLs. Use Instantly to verify discovered email addresses. Do not add Instantly SuperSearch, Clay, or another enrichment workflow now: the current qualification rule is satisfied by either a verified public email or a contact form. Reconsider enrichment only if businesses with neither route become a measured source of otherwise valuable prospects.

The initial discovery experiment crosses 19 business categories with 9 Tahoe–Reno-area locations. Store a business once by Google place ID and store each category/area occurrence separately because adjacent categories and geographic searches overlap. Derive funnel reporting from these records rather than persisting counters: total businesses, businesses with websites, verified emails, verified catch-all emails, contact forms, invalid emails, and businesses contactable by a verified email or contact form. Report the funnel overall and grouped by category, area, and exact combination. Keep businesses without websites or current written contact routes; they may support a future phone channel, but do not build that channel now.

For a contact-form prospect, assign one of the five warmed inbox identities in round-robin order and use that real name and email in the form. Give a cheap model in a Vercel Sandbox the fixed outreach copy and a browser. It may identify and fill the form fields, submit once, and verify a visible success result. It must not bypass a CAPTCHA, accept optional marketing consent, invent required information, or retry after an ambiguous result. Do not build a separate form-outreach table or analytics system; the job only needs to report whether it submitted successfully.

A form submission is not an email sent by Instantly, even when its reply-email field uses an Instantly-connected inbox. It therefore does not count in the `Redesign Outreach` campaign's sent or reply analytics. Accept that limitation instead of rebuilding campaign analytics. Enable `Save non-Instantly emails in Unibox` so resulting messages can appear in Unibox's `Others` folder.

Snapshot on August 2, 2026: the database contains 120 businesses, 108 with source websites, and 79 with redesign previews. Of those 79 prospects, 50 had an email, 7 had only a contact form, and 22 had neither. After removing three incorrect or unusable recipients, 47 emails were uploaded to Instantly; verification found 46 deliverable addresses and skipped one invalid address without sending.

## Offer and conversation

Lead with the completed redesign. The prospect should evaluate finished work rather than imagine what an agency might eventually make.

The five pre-warmed inboxes use their existing sender names and email addresses. The sender truthfully presents Xander as the team's designer instead of pretending that Xander sent the message.

Configure each account signature as the sender's full name only. The sequence already supplies `Thanks,` and the compliance footer immediately identifies Redesign Business and its postal address, so the account signature must not repeat them or add a title, logo, phone number, address, or link.

Use this fixed first-email template:

```text
Subject: We redesigned your website

Hi,

Our designer, Xander, redesigned your website.
It gives potential customers reasons to trust you and hire you:

- {sentence describing proof section 1}
- {sentence describing proof section 2}
- {sentence describing proof section 3}

{redesign link}

What do you think?
We’ll work with you to make it yours.

Thanks,
{{accountSignature}}

Redesign Business
774 Mays Blvd Ste 10301, Incline Village, NV 89451
Advertisement · Unsubscribe
```

Each proof sentence describes one proof section the recipient will actually see in the redesign. Use exactly three grounded sentences. Describe the proof presented rather than writing generic praise or inventing personalization. For example:

- `Your process with LEED-accredited professionals, warranty coverage, and follow-up.`
- `A testimonial from a homeowner who chose Greenwood to build five homes.`
- `Seven awards from Tahoe Quarterly.`

Write every set fresh from the sections in the finished redesign. Do not recycle copy from an earlier outreach artifact merely because the underlying facts are still valid.

## Measurement

- Replies, positive replies, and sales are the decision-making metrics.
- Measure redesign-preview visits with PostHog, using each redesign's unique host to identify the business.
- Use Instantly for email-channel delivery and replies received by the connected inboxes. Use PostHog for redesign-preview visits. Do not add separate form-channel analytics unless missing them becomes a demonstrated problem.
- Instantly open tracking may remain enabled as a directional signal, but do not treat its count as verified human opens.
- Keep Instantly link tracking disabled. It would replace the direct redesign link with a tracking redirect while duplicating the visit signal already captured by PostHog.

Do not insult the existing website. Invite a reply or feedback rather than requiring a meeting.

The preferred sales flow is:

1. Present the redesign by email or the business's contact form.
2. Receive the reply in the warmed sending inbox and manage it from Instantly's Unibox. Contact-form replies may appear in `Others` rather than as campaign replies.
3. The named sender replies in the same thread and copies Xander when design feedback or a sales conversation begins.
4. Xander makes reasonable revisions through email.
5. Reach an agreement.
6. Send a Stripe payment link.
7. Launch the website.

Keep replies going to the warmed sending inboxes and manage them together in Unibox when the named senders are real Redesign Business team members. Do not add a separate reply-to address unless monitoring those conversations becomes an actual problem. If the inbox names are provider-created personas rather than real team members, change the sender identity to Xander or Redesign Business before sending; do not impersonate fictional teammates. Every From and Reply-To identity must accurately identify a real person or Redesign Business.

For the initial Instantly campaign:

- Use all five warmed sending accounts and keep warmup active.
- Keep Instantly's text-only delivery optimization disabled. Use an unstyled, plain-looking email so the redesign and unsubscribe text remain clean clickable links instead of being expanded into raw URLs.
- Keep `Stop sending emails on reply` enabled.
- Leave `Stop campaign for company on reply` disabled while there is only one lead per company.
- Insert Instantly's visible unsubscribe link in the message body and keep the postal address and `Advertisement` label beside it. The optional one-click unsubscribe header may remain enabled.
- Set both `Max new leads` and the campaign `Daily limit` to 30. With a one-email sequence, this sends the 47-lead batch over two sending days.
- Use one 9:00 AM–5:00 PM Pacific schedule across all seven days. There is no current evidence that excluding weekends or narrowing the hours helps this initial 47-lead experiment.

A call is optional when a prospect needs human reassurance. It is not the default call to action or a mandatory step.

## Purchase terms

- Do not show a price or purchase prompt on the redesign preview.
- After a positive reply and personal conversation, send the reusable [$2,000 Stripe checkout](https://buy.stripe.com/00wbJ29D48dteAA08e4wM00).
- Beyond payment details, checkout collects only the customer's name, email, and business name. It accepts cards, Apple Pay, Google Pay, and Link; Pay Later is disabled.
- The buyer owns the website forever.
- Help connect the website to the buyer's domain, including DNS configuration when requested.
- Payment is refundable until the website is connected to the buyer's domain and final afterward.
- Ongoing revisions and support are available separately for $200 per month. They are optional and are not required for ownership.
- Offer installments personally only when the full purchase price is the prospect's objection. Do not advertise installments in the standard checkout; ownership transfers after the final installment.

There is no fixed revision-round promise in the current offer. Handle reasonable pre-purchase feedback through the email conversation and define a stricter boundary only if actual sales reveal that one is needed.

## Product boundary

This product owns business discovery data, public contact methods, redesign jobs, redesign previews, and contact-form submission. Instantly owns inbox warmup, email sending schedules, email account rotation, email follow-ups, email delivery state, replies, and email campaign state. PostHog owns preview-visit analytics.

Do not build a CRM, campaign builder, email sequencer, sending service, or automated sales agent until a concrete bottleneck requires one. Reply handling, revisions, agreements, and closing remain manual while the offer is being validated.
