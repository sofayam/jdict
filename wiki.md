
# The wiki (aka vocab building memory palace)

the purpose of the wiki is to record selected words which have been looked up, creating word pages and tag pages.

## word pages
- these are created by the user on the basis of a word he has just searched for. When he selects a result from the search list he is given the option to create a new word page for this result or, if it exists already, add to an existing word page

the word page contains the following information

- how often the word has been looked up and from what sources (the source will be sent as part of the search url, just treat it as a string for the time being, though it will probably itself be a url)
- additional notes, written in markup 
- tags assignable by the user
- an optional image, copied in by the user using drag and drop, ideally straight from another web page (not sure if this is even possible but it would be nice)

## tag pages
in addtion to such WORD PAGES a TAG PAGE  will also exist for each tag, which shows 
- all words with that tag 
- additional notes
- an optional image

## implementation
word pages and tag pages will be saved as human readable and editable text files. The precise format is undecided but it needs to be easy to type, easy to parse and support delimited multiline text values. 

the following concepts can be defined

- tags
- images
- notes
- contexts (this will be a time when a search occurred and the source)
yaml is probably NOT suitable as it is not easy enough to write. json has too many quotation marks. we will think of something.


## images
image handling will be done by storing all the used images with unique names in a separate folder in a standardised format and a size sufficient to be rendered on a phone with a max size of 1 mb (maybe less - we will see)

## file organisation

the files will be stored in a subdirectory called "wiki", with subdirectories "words", "tags" and "images"

## wiki home page

while the wiki will be built by repeated use of the dictionary lookup function and creation of pages, later use of the wiki, including browsing and adding notes and images, will start from a wiki home page offering (at least) the following lists of pages:

- most recently created words
- most recently edited words
- most recently created tags
- most recently edited tags

## browsing experience

whenever the user views a page he can edit it, adding tags and altering the image or the content of the notes. Adding a tag makes strong use of autocomplete so that once a tag has been defined it is easy to reuse in other places. Adding images uses state of the art browser technology to make this easy on mobile platforms.