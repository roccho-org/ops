#define _DEFAULT_SOURCE
#include "tty.h"
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <limits.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/random.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

/* One reader, one retained frame, latest acknowledgement ID, no worker/queue. */
typedef struct {
    Cdp *cdp; const volatile sig_atomic_t *cancel;
    Frame frame; struct winsize size;
    int cw,ch,left,top,cols,rows,ready,observe,down,dx,dy,button,recapture;
    unsigned modifiers;
    long long stale_since;
    const char *stage, *completion;
    unsigned image, next_image;
    char input[8192]; size_t used;
} Terminal;
static long long clock_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec*1000LL+t.tv_nsec/1000000; }
static int output(Terminal *t, const char *data, size_t len) {
    long long until=clock_ms()+3000;
    while (len && !*t->cancel && clock_ms()<until) {
        ssize_t n=write(STDOUT_FILENO,data,len);
        if (n>0) { data+=n; len-=(size_t)n; continue; }
        if (n<0 && errno!=EAGAIN && errno!=EINTR) return -1;
        struct pollfd p={STDOUT_FILENO,POLLOUT,0}; poll(&p,1,25);
    }
    return len ? -1:0;
}
static int literal(Terminal *t, const char *s) { return output(t,s,strlen(s)); }
static int draw(Terminal *t, Frame *f) {
    double scale=fmin((double)t->size.ws_col*t->cw/f->width,(double)(t->size.ws_row-1)*t->ch/f->height);
    t->cols=(int)floor(f->width*scale/t->cw); t->rows=(int)floor(f->height*scale/t->ch);
    if (t->cols<1 || t->rows<1) return -1;
    t->left=(t->size.ws_col-t->cols)/2; t->top=(t->size.ws_row-1-t->rows)/2;
    t->ready=0; t->down=0; t->recapture=0;
    char control[256]; int n;
    if (t->image) {
        n=snprintf(control,sizeof(control),"\033_Ga=d,d=I,i=%u,q=2;\033\\",t->image);
        if (output(t,control,(size_t)n)) return -1;
    }
    if (++t->next_image==0) ++t->next_image;
    t->image=t->next_image;
    n=snprintf(control,sizeof(control),"\033[2J\033[%u;1H%s | Ctrl-Q: exit\033[%d;%dH",
        t->size.ws_row,t->observe ? "observe only":"fresh-frame input; bounded drag; committed text",t->top+1,t->left+1);
    if (n<0 || (size_t)n>=sizeof(control) || output(t,control,(size_t)n)) return -1;
    for (size_t i=0;i<f->len;) {
        size_t take=f->len-i; if (take>4096) take=4096;
        int more=i+take<f->len;
        if (!i) n=snprintf(control,sizeof(control),"\033_Ga=T,t=d,f=100,i=%u,p=1,c=%d,r=%d,C=1,q=0,m=%d;",t->image,t->cols,t->rows,more);
        else n=snprintf(control,sizeof(control),"\033_Gm=%d;",more);
        if (output(t,control,(size_t)n) || output(t,f->png+i,take) || literal(t,"\033\\")) return -1;
        i+=take;
    }
    frame_free(&t->frame); t->frame=*f; memset(f,0,sizeof(*f)); return 0;
}
static int refresh(Terminal *t, int force) {
    t->stage="frame-capture";
    Frame f; int r=cdp_frame(t->cdp,&f);
    if (r==CDP_STALE) {
        if (!t->recapture) t->stale_since=clock_ms();
        t->ready=0; t->down=0; t->recapture=1;
        return 0; /* retry the read-only frame, never the previous input */
    }
    if (r) return -1;
    if (!force && !t->recapture && frame_equal(&t->frame,&f)) { frame_free(&f); return 0; }
    r=draw(t,&f); frame_free(&f); return r;
}
static int apply(Terminal *t, Action *a) {
    if (!t->ready || t->observe) return 0;
    t->stage="input-dispatch";
    int r=cdp_apply(t->cdp,&t->frame,a);
    t->completion=r==CDP_OK ? "acknowledged" : r==CDP_ERROR ? "unknown":"not-sent";
    t->ready=0; t->down=0;
    /* Discard the remainder of this read: it belongs to the old presentation. */
    t->used=0;
    if (r==CDP_ERROR) return -1;
    if (r==CDP_STALE) fputs("cdp-tty: stage=input-check completion=not-sent reason=stale-frame; no input replay\n",stderr);
    if (r==CDP_UNSUPPORTED) fputs("cdp-tty: stage=input-check completion=not-sent reason=unsupported; no input replay\n",stderr);
    return refresh(t,1);
}
static unsigned mouse_modifiers(int b) {
    return ((b&4) ? 8u:0u) | ((b&8) ? 1u:0u) | ((b&16) ? 2u:0u);
}
static int inside(Terminal *t, int x, int y) {
    return x>t->left && x<=t->left+t->cols && y>t->top && y<=t->top+t->rows;
}
static int mouse(Terminal *t, int b, int x, int y, char end) {
    if (!t->ready || t->observe || b<0 || b>127 || !inside(t,x,y)) { t->down=0; return 0; }
    int button=b&3; unsigned modifiers=mouse_modifiers(b);
    if (b&32) { /* No mouse effect before release; retain only the start point. */
        if (!t->down || button!=t->button || modifiers!=t->modifiers) t->down=0;
        return 0;
    }
    if (!(b&64) && button<3 && end=='M') {
        t->down=1; t->dx=x; t->dy=y; t->button=button; t->modifiers=modifiers; return 0;
    }
    Action a={.modifiers=modifiers};
    if ((b&64) && button<2 && end=='M') { a.kind=WHEEL; a.delta=button ? 80:-80; }
    else {
        if ((b&64) || end!='m' || !t->down || button!=t->button || modifiers!=t->modifiers) { t->down=0; return 0; }
        a.kind=(x==t->dx && y==t->dy) ? CLICK:DRAG; a.button=button; t->down=0;
        a.x2=(x-t->left-0.5)*t->frame.css_width/t->cols;
        a.y2=(y-t->top-0.5)*t->frame.css_height/t->rows;
        x=t->dx; y=t->dy;
    }
    a.x=(x-t->left-0.5)*t->frame.css_width/t->cols;
    a.y=(y-t->top-0.5)*t->frame.css_height/t->rows;
    return apply(t,&a);
}
static int numbers(const char *s, size_t n, int *v, size_t count, char final) {
    const char *end=s+n;
    for (size_t i=0;i<count;i++) {
        if (s>=end || *s<'0' || *s>'9') return -1;
        unsigned value=0;
        do { if (value>6553) return -1; value=value*10+(unsigned)(*s++-'0'); } while (s<end && *s>='0' && *s<='9');
        if (value>65535 || s>=end || *s++!=(i+1==count ? final:';')) return -1;
        v[i]=(int)value;
    }
    return s==end ? 0:-1;
}
static int ascii_key(unsigned code, Key *key) {
    if (code>='a' && code<='z') { *key=(Key)(LETTER_A+code-'a'); return 1; }
    if (code>='A' && code<='Z') { *key=(Key)(LETTER_A+code-'A'); return 1; }
    if (code>='0' && code<='9') { *key=(Key)(DIGIT_0+code-'0'); return 1; }
    switch (code) {
    case 13: *key=ENTER; return 1;
    case 9: *key=TAB; return 1;
    case 27: *key=ESCAPE; return 1;
    case 127: *key=BACKSPACE; return 1;
    default: return 0;
    }
}
static unsigned key_modifiers(int wire) {
    unsigned m=(unsigned)(wire-1);
    return ((m&1) ? 8u:0u) | ((m&2) ? 1u:0u) | ((m&4) ? 2u:0u) | ((m&8) ? 4u:0u);
}
static int csi_key(const char *s, size_t n, Action *a) {
    static const char *const seq[]={"\033[A","\033[B","\033[C","\033[D","\033[H","\033[F","\033[3~","\033[5~","\033[6~","\033[2~"};
    static const Key key[]={UP,DOWN,RIGHT,LEFT,HOME,END,DELETE_KEY,PAGE_UP,PAGE_DOWN,INSERT_KEY};
    a->kind=KEY;
    for (size_t j=0;j<sizeof(seq)/sizeof(*seq);j++)
        if (strlen(seq[j])==n && !memcmp(s,seq[j],n)) { a->key=key[j]; return 1; }
    if (n==3 && s[2]=='Z') { a->key=TAB; a->modifiers=8; return 1; }
    int v[2]; char end=s[n-1];
    if (!numbers(s+2,n-2,v,2,end) && v[1]>=1 && v[1]<=16) {
        a->modifiers=key_modifiers(v[1]);
        if (end=='u') return ascii_key((unsigned)v[0],&a->key);
        if (v[0]==1) {
            static const char arrows[]="ABCDHF";
            const char *p=strchr(arrows,end);
            if (p) { a->key=key[p-arrows]; return 1; }
        }
    }
    if (end=='u' && !numbers(s+2,n-2,v,1,end)) return ascii_key((unsigned)v[0],&a->key);
    return 0; /* unsupported/keyup/control reports are never interpreted as text */
}
/* Returns -1 error, 1 exit, 0 continue. Incomplete tokens stay bounded. */
static int consume(Terminal *t, int escape_timeout) {
    while (t->used) {
        char *s=t->input; size_t n=0; Action a={0}; int do_apply=0;
        if ((unsigned char)s[0]==17) return 1;
        if (s[0]=='\033') {
            if (t->used==1) { if (!escape_timeout) return 0; n=1; a.kind=KEY; a.key=ESCAPE; do_apply=1; }
            else if (s[1]=='_' || s[1]==']' || s[1]=='P' || s[1]=='^' || s[1]=='X') {
                if (t->used<3) return 0;
                char *end=strstr(s+3,"\033\\"); if (!end) return 0;
                n=(size_t)(end-s)+2;
                char *id_end=NULL; errno=0;
                unsigned long id=0;
                if (s[1]=='_' && s[2]=='G' && !strncmp(s+3,"i=",2) && s[5]>='0' && s[5]<='9') id=strtoul(s+5,&id_end,10);
                if (!t->recapture && !errno && id && id<=UINT_MAX && id==t->image && id_end && (*id_end==';' || *id_end==',')) {
                    char *semi=memchr(s+3,';',n-5);
                    if (!semi || semi+3!=end || memcmp(semi+1,"OK",2)) return -1;
                    t->ready=1;
                }
            } else if (s[1]=='[') {
                size_t k=2; while (k<t->used && !((unsigned char)s[k]>=0x40 && (unsigned char)s[k]<=0x7e)) k++;
                if (k==t->used) return 0;
                n=k+1;
                if (n==6 && !memcmp(s,"\033[200~",6)) {
                    char *end=strstr(s+6,"\033[201~"); if (!end) return 0;
                    size_t count=(size_t)(end-(s+6)); if (count>4096 || memchr(s+6,0,count)) return -1;
                    char text[4097]; memcpy(text,s+6,count); text[count]=0;
                    if (!valid_utf8((unsigned char *)text,count)) return -1;
                    n=(size_t)(end-s)+6;
                    memmove(s,s+n,t->used-n); t->used-=n; s[t->used]=0;
                    a.kind=TEXT; a.text=text; if (apply(t,&a)) return -1; continue;
                }
                if (s[2]=='<') {
                    int v[3]; char e=s[k];
                    if ((e!='M' && e!='m') || numbers(s+3,n-3,v,3,e)) return -1;
                    memmove(s,s+n,t->used-n); t->used-=n; s[t->used]=0;
                    if (mouse(t,v[0],v[1],v[2],e)) return -1;
                    continue;
                }
                if (s[k]=='t') {
                    int v[2];
                    if (n>5 && !memcmp(s,"\033[6;",4) && !numbers(s+4,n-4,v,2,'t') && v[0]>0 && v[0]<=256 && v[1]>0 && v[1]<=256) { t->ch=v[0]; t->cw=v[1]; }
                } else {
                    do_apply=csi_key(s,n,&a);
                }
            } else if (s[1]=='O') { if (t->used<3) return 0; n=3; }
            else { n=2; a.kind=KEY; a.modifiers=1; do_apply=ascii_key((unsigned char)s[1],&a.key); }
        } else if ((unsigned char)s[0]<32 || (unsigned char)s[0]==127) {
            n=1; a.kind=KEY;
            switch ((unsigned char)s[0]) {
            case 13: case 10: a.key=ENTER; do_apply=1; break;
            case 9: a.key=TAB; do_apply=1; break;
            case 8: case 127: a.key=BACKSPACE; do_apply=1; break;
            case 1: a.key=SELECT_ALL; do_apply=1; break;
            default:
                if ((unsigned char)s[0]>=2 && (unsigned char)s[0]<=26) {
                    a.key=(Key)(LETTER_A+(unsigned char)s[0]-1); a.modifiers=2; do_apply=1;
                }
                break;
            }
        } else {
            n=0; while (n<t->used && (unsigned char)s[n]>=32 && (unsigned char)s[n]!=127) n++;
            if (n>4096) return -1;
            /* A committed IME string can arrive in several reads, including
             * between valid codepoints. Use the same bounded quiet interval
             * as Escape; a read boundary is not an input-commit boundary. */
            if (n==t->used && !escape_timeout) return 0;
            if (!valid_utf8((unsigned char *)s,n)) { if (t->used>=sizeof(t->input)-1) return -1; return 0; }
            char text[4097]; memcpy(text,s,n); text[n]=0;
            memmove(s,s+n,t->used-n); t->used-=n; s[t->used]=0;
            a.kind=TEXT; a.text=text; if (apply(t,&a)) return -1; continue;
        }
        memmove(s,s+n,t->used-n); t->used-=n; s[t->used]=0;
        if (do_apply && apply(t,&a)) return -1;
    }
    return 0;
}
int tty_run(Cdp *c, int observe, const volatile sig_atomic_t *cancel) {
    Terminal t={.cdp=c,.observe=observe,.cancel=cancel,.stage="terminal-setup",.completion="not-sent"};
    struct termios saved, raw; int flags=-1, result=CDP_ERROR, entered=0;
    if (!isatty(STDIN_FILENO) || !isatty(STDOUT_FILENO) || tcgetattr(STDIN_FILENO,&saved) ||
        ioctl(STDOUT_FILENO,TIOCGWINSZ,&t.size) || t.size.ws_col<2 || t.size.ws_row<3) {
        fputs("cdp-tty: stage=terminal-setup completion=not-sent; real TTY required\n",stderr);
        return CDP_UNSUPPORTED;
    }
    if (getrandom(&t.next_image,sizeof(t.next_image),0)!=(ssize_t)sizeof(t.next_image)) return CDP_ERROR;
    raw=saved; cfmakeraw(&raw);
    flags=fcntl(STDOUT_FILENO,F_GETFL); if (flags<0 || fcntl(STDOUT_FILENO,F_SETFL,flags|O_NONBLOCK)) return CDP_ERROR;
    if (tcsetattr(STDIN_FILENO,TCSANOW,&raw)) goto done;
    entered=1;
    if (literal(&t,"\033[?1049h\033[?25l\033[?1002h\033[?1006h\033[?2004h\033[16t")) goto done;
    long long next=clock_ms(), last_byte=next, pending=next;
    while (!*cancel) {
        long long now=clock_ms(); struct winsize size;
        t.stage="terminal-size";
        if (ioctl(STDOUT_FILENO,TIOCGWINSZ,&size) || size.ws_col<2 || size.ws_row<3) goto done;
        if (size.ws_col!=t.size.ws_col || size.ws_row!=t.size.ws_row) {
            t.size=size; t.ready=0; t.down=0; t.used=0;
            if (t.cw && t.ch && refresh(&t,1)) goto done;
            pending=clock_ms(); next=pending+500;
        }
        if (!t.cw || !t.ch) { if (now-pending>3000) { t.stage="cell-size-reply"; goto done; } }
        else if ((t.recapture && now>=next) || (!t.frame.png && !t.recapture) ||
                 (t.ready && !t.down && !t.used && now>=next)) {
            if (refresh(&t,t.recapture)) goto done;
            pending=clock_ms(); next=pending+(t.recapture ? 50:500);
        }
        if (t.recapture && now-t.stale_since>3000) { t.stage="unstable-frame"; goto done; }
        if (t.frame.png && !t.ready && !t.recapture && now-pending>3000) { t.stage="image-ack-timeout"; goto done; }
        t.stage="terminal-read";
        struct pollfd p={STDIN_FILENO,POLLIN,0}; int r=poll(&p,1,25);
        if (r<0 && errno!=EINTR) goto done;
        if (r>0) {
            if (!(p.revents&POLLIN) || t.used>=sizeof(t.input)-1) goto done;
            ssize_t n=read(STDIN_FILENO,t.input+t.used,sizeof(t.input)-t.used-1);
            if (n<=0 || memchr(t.input+t.used,0,(size_t)n)) goto done;
            t.used+=(size_t)n; t.input[t.used]=0; last_byte=clock_ms();
        }
        int was_ready=t.ready;
        t.stage="terminal-token";
        r=consume(&t,clock_ms()-last_byte>40);
        if (r<0) goto done;
        if (r>0) { result=CDP_OK; goto done; }
        if (was_ready && !t.ready) { pending=clock_ms(); next=pending+(t.recapture ? 50:500); }
        if (t.used>=sizeof(t.input)-1 || (t.used && clock_ms()-last_byte>3000)) { t.stage="incomplete-input"; goto done; }
    }
    result=CDP_OK;
done:
    if (result!=CDP_OK && !*cancel)
        fprintf(stderr,"cdp-tty: stage=%s method=%s completion=%s; no input replay\n",
            t.stage,cdp_error_method(c),t.completion);
    if (entered) {
        /* Best effort after signal/transport failure, always restore termios/flags. */
        char end[200];
        const volatile sig_atomic_t zero=0; t.cancel=&zero;
        if (t.image) {
            int n=snprintf(end,sizeof(end),"\033_Ga=d,d=I,i=%u,q=2;\033\\",t.image);
            output(&t,end,(size_t)n);
        }
        literal(&t,"\033[?2004l\033[?1006l\033[?1002l\033[?25h\033[?1049l");
        if (tcsetattr(STDIN_FILENO,TCSANOW,&saved)) result=CDP_ERROR;
    }
    if (flags>=0) fcntl(STDOUT_FILENO,F_SETFL,flags);
    frame_free(&t.frame); return result;
}