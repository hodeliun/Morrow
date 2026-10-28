## Parent

https://github.com/hodeliun/Morrow/issues/45

## What to build

Make layered menus and icon dialogs usable, constrain uploaded column icons, and prevent stale document selection errors when collapsing linked tables.

## Acceptance criteria

- [ ] The icon picker is above its originating property panel and upload is reachable with an ordinary mouse click; focus, outside click and Escape respect the topmost layer and restore focus.
- [ ] Uploaded portrait raster and SVG icons fit the intended column header and settings bounds, remain correct after changing type/reset and reopening, and do not alter page icon sizing.
- [ ] Repeated linked-view collapse/expand and reopening produce no document selection errors or content loss; error listeners cover reopened pages.
- [ ] Page-options Escape closes the correct menu; other menus and dialogs preserve expected behavior.
- [ ] User text is translated, interactions accessible, and relevant tests plus genuine synthetic UI evidence are recorded.

## Blocked by

None — can start immediately; coordinate shared editor/table files with other deliveries.


