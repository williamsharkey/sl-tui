CC = cc
CFLAGS = -Wall -Wextra -O2 -std=c11
LDFLAGS = -lm

# Detect chafa via pkg-config
CHAFA_CFLAGS := $(shell pkg-config --cflags chafa 2>/dev/null)
CHAFA_LIBS := $(shell pkg-config --libs chafa 2>/dev/null)
ifneq ($(CHAFA_LIBS),)
  CFLAGS += $(CHAFA_CFLAGS) -DHAVE_CHAFA
  LDFLAGS += $(CHAFA_LIBS)
endif

SRCDIR = src
SRCS = $(SRCDIR)/main.c \
       $(SRCDIR)/app.c \
       $(SRCDIR)/terminal.c \
       $(SRCDIR)/screen.c \
       $(SRCDIR)/color.c \
       $(SRCDIR)/grid.c \
       $(SRCDIR)/pixel_to_cells.c \
       $(SRCDIR)/renderer.c \
       $(SRCDIR)/login.c \
       $(SRCDIR)/chat.c \
       $(SRCDIR)/input.c \
       $(SRCDIR)/ipc.c \
       $(SRCDIR)/credentials.c \
       $(SRCDIR)/cjson/cJSON.c

OBJS = $(SRCS:.c=.o)
TARGET = sl-tui

.PHONY: all clean test

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CC) $(OBJS) $(LDFLAGS) -o $@

$(SRCDIR)/%.o: $(SRCDIR)/%.c
	$(CC) $(CFLAGS) -c $< -o $@

$(SRCDIR)/cjson/%.o: $(SRCDIR)/cjson/%.c
	$(CC) -Wall -O2 -std=c11 -c $< -o $@

# Test binary — links all src objects except main.o, plus test file
TEST_SRCS = $(filter-out $(SRCDIR)/main.c, $(SRCS))
TEST_OBJS = $(TEST_SRCS:.c=.o)
TEST_BIN = test/test_c

test: $(TEST_OBJS)
	$(CC) $(CFLAGS) -I$(SRCDIR) test/test_c.c $(TEST_OBJS) $(LDFLAGS) -o $(TEST_BIN)
	./$(TEST_BIN)

clean:
	rm -f $(OBJS) $(TARGET) $(TEST_BIN)
