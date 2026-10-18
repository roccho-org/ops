#ifndef CDP_TTY_H
#define CDP_TTY_H
#include <signal.h>
#include <stddef.h>
#include <stdint.h>

/* Sequential, caller-owned connection. No global signal/TTY/process ownership. */
typedef struct Cdp Cdp;
typedef struct {
    char *png; size_t len;
    char *geometry;
    uint32_t width, height;
    double css_width, css_height;
} Frame;
typedef enum { TEXT, KEY, CLICK, WHEEL, DRAG } ActionKind;
typedef enum { ENTER, TAB, BACKSPACE, DELETE_KEY, ESCAPE, LEFT, RIGHT, UP, DOWN, HOME, END, SELECT_ALL,
    PAGE_UP, PAGE_DOWN, INSERT_KEY, LETTER_A, LETTER_Z=LETTER_A+25,
    DIGIT_0, DIGIT_9=DIGIT_0+9, FUNCTION_1, FUNCTION_12=FUNCTION_1+11 } Key;
typedef struct {
    ActionKind kind;
    const char *text;
    Key key;
    double x, y, delta, x2, y2;
    unsigned modifiers; /* CDP: Alt=1, Control=2, Meta=4, Shift=8 */
    int button; /* 0 left, 1 middle, 2 right */
} Action;
enum { CDP_OK = 0, CDP_ERROR = 1, CDP_STALE = 2, CDP_UNSUPPORTED = 3 };
int cdp_attach(Cdp **out, const char *page_ws, const volatile sig_atomic_t *cancel);
void cdp_detach(Cdp *c);
/* Fixed method name only: never URLs, typed text, page content or credentials. */
const char *cdp_error_method(const Cdp *c);
int cdp_frame(Cdp *c, Frame *out);
void frame_free(Frame *f);
/* Reject changed pixels/geometry before input. Not an atomic page lock. */
int cdp_apply(Cdp *c, const Frame *shown, const Action *action);
int frame_equal(const Frame *a, const Frame *b);
int valid_utf8(const unsigned char *s, size_t n);
#endif
