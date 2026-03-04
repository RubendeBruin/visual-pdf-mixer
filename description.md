# PDF mixer

PDF mixer is a desktop tool for combining multiple pdf documents into a single one.

The idea is that you start with a "main" document and that you insert other pdf files or pages from those pdfs into the main document. The main pdf document can then be saved.

UI
The gui shows two panes. The left pane holds to main pdf and the right pane the source pdf.
The pages are rendered as thumbnails and are numbered.

## Inserting pages

PDFs to be inserted can be loaded on the right side. These are also rendered as thumbnails.

The user can select one, multiple or all pages from the right document and drag-and-drop them between the pages of the main document.


## Deleting pages

Pages from a pdf can be deleted by selecting them (in the left view) and pressing delete.

## UI layout options

Use a light theme
The bottons are on the top
Buttons affecting the left document are on the left
- open
- save
- save as
- delete (deleted selected page(s))

Button affecting the right document are on the right
- open

It is also possible to open a pdf by dragging it onto the left or right document panes. 

The drop-logic should be as follows:

When dragging pages from the source into the main pane it is always possible to drop. The place of insertion should just be the nearest page break or start or end of the document, whiichever the cursor is nearest to. The insert location should be shown with a bright-green line and the text "insert X pages here".
