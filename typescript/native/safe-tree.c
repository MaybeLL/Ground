#define _GNU_SOURCE
#include <node_api.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif

static napi_value fail(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}
static int directory_fd(napi_env env, napi_value value, int *fd) {
  struct stat st;
  if (napi_get_value_int32(env, value, fd) != napi_ok || *fd < 0 ||
      fstat(*fd, &st) != 0 || !S_ISDIR(st.st_mode)) {
    fail(env, "a live directory fd is required");
    return 0;
  }
  return 1;
}
static int entry_name(napi_env env, napi_value value, char name[NAME_MAX + 1]) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length == 0 || length > NAME_MAX ||
      napi_get_value_string_utf8(env, value, name, NAME_MAX + 1, &length) != napi_ok ||
      memchr(name, '\0', length) != NULL || strchr(name, '/') != NULL ||
      strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
    fail(env, "one safe directory entry name is required");
    return 0;
  }
  return 1;
}
static napi_value directory_entries(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], result;
  int fd;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 1 || !directory_fd(env, argv[0], &fd)) return NULL;
  // A fresh open file description keeps each traversal's cursor independent.
  int scan_fd = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (scan_fd < 0) return fail(env, "cannot reopen directory for listing");
  DIR *dir = fdopendir(scan_fd);
  if (!dir) {
    close(scan_fd);
    return fail(env, "cannot list opened directory");
  }
  if (napi_create_array(env, &result) != napi_ok) {
    closedir(dir);
    return NULL;
  }
  uint32_t index = 0;
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(dir)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
      continue;
    napi_value name;
    if (napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_set_element(env, result, index++, name) != napi_ok) {
      closedir(dir);
      return NULL;
    }
    errno = 0;
  }
  int read_error = errno;
  closedir(dir);
  if (read_error != 0) return fail(env, "directory listing changed or failed");
  return result;
}
static napi_value entry_stat(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], result, value;
  int fd;
  char name[NAME_MAX + 1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 2 || !directory_fd(env, argv[0], &fd) ||
      !entry_name(env, argv[1], name)) return NULL;
  struct stat st;
  if (fstatat(fd, name, &st, AT_SYMLINK_NOFOLLOW) != 0)
    return fail(env, "cannot stat directory entry without following links");
  const char *kind = S_ISREG(st.st_mode) ? "file" :
                     S_ISDIR(st.st_mode) ? "directory" :
                     S_ISLNK(st.st_mode) ? "link" : "other";
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, result, "kind", value) != napi_ok ||
      napi_create_uint32(env, (uint32_t)st.st_mode, &value) != napi_ok ||
      napi_set_named_property(env, result, "mode", value) != napi_ok ||
      napi_create_uint32(env, (uint32_t)st.st_nlink, &value) != napi_ok ||
      napi_set_named_property(env, result, "nlink", value) != napi_ok ||
      napi_create_double(env, (double)st.st_size, &value) != napi_ok ||
      napi_set_named_property(env, result, "size", value) != napi_ok)
    return NULL;
  char identity[64];
  snprintf(identity, sizeof(identity), "%ju:%ju",
           (uintmax_t)st.st_dev, (uintmax_t)st.st_ino);
  if (napi_create_string_utf8(env, identity, NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, result, "identity", value) != napi_ok)
    return NULL;
  return result;
}
static napi_value open_entry(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3], result;
  int fd;
  bool directory;
  char name[NAME_MAX + 1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 3 || !directory_fd(env, argv[0], &fd) ||
      !entry_name(env, argv[1], name) ||
      napi_get_value_bool(env, argv[2], &directory) != napi_ok)
    return NULL;
  // A file can become a FIFO after the caller's stat. Never wait for a writer
  // before checking the object actually opened; regular files ignore NONBLOCK.
  int flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK;
  if (directory) flags |= O_DIRECTORY;
  int opened = openat(fd, name, flags);
  if (opened < 0) return fail(env, "directory entry cannot be opened without following links");
  struct stat st;
  if (fstat(opened, &st) != 0 ||
      (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode))) {
    close(opened);
    return fail(env, "opened entry is not the required regular file or directory");
  }
  if (napi_create_int32(env, opened, &result) != napi_ok) {
    close(opened);
    return NULL;
  }
  return result;
}
static napi_value entry_link(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], result;
  int fd;
  char name[NAME_MAX + 1], link[PATH_MAX + 1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 2 || !directory_fd(env, argv[0], &fd) ||
      !entry_name(env, argv[1], name)) return NULL;
  ssize_t length = readlinkat(fd, name, link, PATH_MAX);
  if (length < 0 || length >= PATH_MAX)
    return fail(env, "cannot read bounded directory entry link");
  link[length] = '\0';
  if (napi_create_string_utf8(env, link, (size_t)length, &result) != napi_ok)
    return NULL;
  return result;
}
// Sync writes operate relative to pinned descriptors. Existing entries are
// parked in recovery first; exclusive creation never overwrites a late editor.
static napi_value mutate_entry(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5], result;
  int fd;
  int32_t mode;
  bool link;
  char name[NAME_MAX + 1];
  void *bytes;
  size_t length;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 5 ||
      !directory_fd(env, argv[0], &fd) || !entry_name(env, argv[1], name) ||
      napi_get_buffer_info(env, argv[2], &bytes, &length) != napi_ok ||
      napi_get_value_int32(env, argv[3], &mode) != napi_ok ||
      napi_get_value_bool(env, argv[4], &link) != napi_ok) return NULL;
  if (length > 64 * 1024 * 1024 || mode < 0 || mode > 0777) return fail(env, "invalid bounded sync entry");
  if (link) {
    if (length == 0 || length >= PATH_MAX || memchr(bytes, 0, length)) return fail(env, "invalid sync link");
    char *target = malloc(length + 1);
    if (!target) return fail(env, "cannot allocate sync link");
    memcpy(target, bytes, length); target[length] = 0;
    int rc = symlinkat(target, fd, name); free(target);
    if (rc != 0) return fail(env, "cannot create private sync link");
  } else {
    int out = openat(fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (out < 0) return fail(env, "cannot create private sync file");
    size_t done = 0;
    while (done < length) {
      ssize_t n = write(out, (char *)bytes + done, length - done);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) { close(out); return fail(env, "cannot write sync file; partial entry retained"); }
      done += (size_t)n;
    }
    int rc = fchmod(out, (mode_t)mode);
    if (rc == 0) rc = fsync(out);
    close(out);
    if (rc != 0) return fail(env, "cannot persist sync file; partial entry retained");
  }
  if (fsync(fd) != 0) return fail(env, "cannot persist sync directory");
  napi_get_undefined(env, &result); return result;
}
static napi_value park_entry(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4], result;
  int fd, destination;
  char name[NAME_MAX + 1], saved[NAME_MAX + 1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 4 ||
      !directory_fd(env, argv[0], &fd) || !entry_name(env, argv[1], name) ||
      !directory_fd(env, argv[2], &destination) || !entry_name(env, argv[3], saved)) return NULL;
  struct stat st;
  if (fstatat(destination, saved, &st, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT)
    return fail(env, "recovery destination already exists or is unavailable");
#ifdef __APPLE__
  int moved = renameatx_np(fd, name, destination, saved, RENAME_EXCL);
#elif defined(__linux__)
  int moved = (int)syscall(SYS_renameat2, fd, name, destination, saved, 1 /* RENAME_NOREPLACE */);
#else
  return fail(env, "atomic no-replace recovery rename is unavailable");
#endif
  const char *failed_step = moved != 0 ? "rename" : fsync(destination) != 0 ? "sync destination" : fsync(fd) != 0 ? "sync source" : NULL;
  if (failed_step) {
    char message[256];
    snprintf(message, sizeof(message), "cannot park sync input (%s); retain recovery material: %s", failed_step, strerror(errno));
    return fail(env, message);
  }
  napi_get_undefined(env, &result); return result;
}
static napi_value remove_entry(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3], result;
  int fd;
  bool directory;
  char name[NAME_MAX + 1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3 ||
      !directory_fd(env, argv[0], &fd) || !entry_name(env, argv[1], name) ||
      napi_get_value_bool(env, argv[2], &directory) != napi_ok) return NULL;
  if (unlinkat(fd, name, directory ? AT_REMOVEDIR : 0) != 0 || fsync(fd) != 0)
    return fail(env, "cannot remove sync entry (nonempty directories are preserved)");
  napi_get_undefined(env, &result); return result;
}
static napi_value mkdir_entry(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], result;
  int fd;
  char name[NAME_MAX + 1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2 ||
      !directory_fd(env, argv[0], &fd) || !entry_name(env, argv[1], name)) return NULL;
  if (mkdirat(fd, name, 0755) != 0 || fsync(fd) != 0) return fail(env, "cannot persist sync directory");
  napi_get_undefined(env, &result); return result;
}
napi_status register_safe_tree(napi_env env, napi_value exports) {
  const struct { const char *name; napi_callback callback; } functions[] = {
    {"directoryEntries", directory_entries},
    {"entryStat", entry_stat},
    {"openEntry", open_entry},
    {"entryLink", entry_link},
    {"replaceEntry", mutate_entry},
    {"parkEntry", park_entry},
    {"removeEntry", remove_entry},
    {"mkdirEntry", mkdir_entry},
  };
  for (size_t i = 0; i < sizeof(functions) / sizeof(functions[0]); i++) {
    napi_value function;
    napi_status status = napi_create_function(env, functions[i].name,
        NAPI_AUTO_LENGTH, functions[i].callback, NULL, &function);
    if (status != napi_ok) return status;
    status = napi_set_named_property(env, exports, functions[i].name, function);
    if (status != napi_ok) return status;
  }
  return napi_ok;
}
