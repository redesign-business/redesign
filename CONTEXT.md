# Redesign

This context creates improved websites for small businesses and presents the finished work to prospective customers.

## Language

**Business**:
A small business whose public information supplies the source material for a website and whose owner may buy the finished work.

**Google listing**:
A Google Maps entry for a location, practitioner, team, or organization. Several Google listings may describe the same Business.

**Contact method**:
A public email address, contact-form URL, or phone number associated with a Business. A Business may have many Contact methods; preserving one does not make it eligible for outreach.

**Prospect**:
A business selected for outreach after a redesign preview has been prepared.
_Avoid_: Lead, account

**Redesign job**:
One request to create or improve a business website.

**Redesign preview**:
A deployed website created for a specific business before that business has agreed to buy it.
_Avoid_: Demo, mockup

**Wireframe**:
A page assembled from proven section layouts with final copy, selected images, and crop positioning. Content adapts to the best-fitting layout; the composition is not invented or restructured.

**Image contact sheet**:
An ID-labeled grid of the bounded image set supplied to the page-building model.

**Style pass**:
The stage that defines a Wireframe's colors, typography, spacing, radius, borders, and shadows while preserving its content and composition.

**Image upscaling**:
An optional operation that enlarges a selected source image while attempting to preserve or improve its visual quality.

**Outreach**:
A cold email or website contact-form message that presents a redesign preview to a prospect.
_Avoid_: Sales event, campaign

**Positive reply**:
A prospect response that expresses interest, offers feedback, or asks about next steps. It is the first success signal, not a sale.

**Sales conversation**:
The customer-facing exchange that begins after a positive reply and may end in an agreement and payment. It is not part of redesign production history.

**Run**:
One internal generation attempt for a website. Runs are production history, not customer-facing sales activity.

**Session**:
One model-usage record within a run.

**Sandbox**:
The isolated environment in which a run executes.

**Agent command**:
The detached website-generation process running inside a sandbox.

**Website slug**:
The stable identifier for one website. It usually comes from the source domain without its top-level domain, so `example.com` becomes `example`, but can differ when one business has multiple websites.

**Generated repo**:
The source repository containing one redesign preview.

## Data conventions

Every database table has an `id` in the `<table-prefix>_<uuid>` format plus `created_at` and `updated_at` timestamps.
