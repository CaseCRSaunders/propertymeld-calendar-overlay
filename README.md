# Property Meld calendar overlay

A Tampermonkey userscript that puts hidden jobs back on the Property Meld
calendar.

## The problem

Property Meld's calendar drops a job in two cases:

- **Completed before its scheduled start.** The calendar feed leaves out any
  meld marked complete before its appointment time.
- **Started but not finished.** The calendar page's status filter excludes
  `PENDING_COMPLETION`, which is the status a job takes once it is started.

The appointment data is still on the meld in both cases. The script reads it
and redraws the job.

## What it does

- Draws each hidden job as a dashed block at its scheduled time, in its
  technician's column.
- Green with a check mark means completed. Blue with an arrow means started.
- Clicking a block opens that meld's page.
- Skips cancelled melds, and skips jobs Property Meld already shows.
- A button at bottom right shows how many hidden jobs are drawn and turns the
  overlay on and off.

It runs in your logged-in Property Meld session and makes the same requests the
calendar page makes, so it needs no API keys.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open `meld-calendar-overlay.user.js` in this repo and copy its contents.
3. In Tampermonkey, choose **Create a new script**, replace the template with
   what you copied, and save. Alternatively, download the file and drag it onto
   the Tampermonkey dashboard.
4. Open the Property Meld calendar. The button appears at bottom right.

To update, repeat steps 2 and 3. This repo is private, so Tampermonkey cannot
update the script on its own.

## Limits

- Works in Week and multi-day views. The 1-day view (hours across the top) is
  not supported, and the button says so.
- Jobs are placed in in-house technician columns only. Vendor-assigned jobs are
  not drawn.
- It relies on the calendar's current page layout (a CSS grid with named
  column lines). A Property Meld redesign could break it.
- Times follow the browser's time zone.
