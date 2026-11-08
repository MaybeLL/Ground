#define _GNU_SOURCE
#include <node_api.h>
#include <sys/socket.h>
#include <sys/file.h>
#include <sys/types.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <sys/stat.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <uv.h>

static napi_value peer_uid(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t fd;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "a live Unix socket fd is required");
    return NULL;
  }
  uid_t uid;
#if defined(__APPLE__)
  gid_t gid;
  if (getpeereid(fd, &uid, &gid) != 0) {
#elif defined(__linux__)
  struct ucred peer;
  socklen_t length = sizeof(peer);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &length) != 0 ||
      length != sizeof(peer)) {
#else
  if (1) {
#endif
    napi_throw_error(env, NULL, "cannot read Unix socket peer credentials");
    return NULL;
  }
#if defined(__linux__)
  uid = peer.uid;
#endif
  napi_value value;
  if (napi_create_uint32(env, (uint32_t)uid, &value) != napi_ok) return NULL;
  return value;
}

/* Always nonblocking. Waiting callers retry in JS without occupying a libuv worker. */
static napi_value try_lock(napi_env env, napi_callback_info info) {
  napi_value argv[2], result;
  size_t argc = 2;
  int32_t fd;
  bool shared;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2
      || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0
      || napi_get_value_bool(env, argv[1], &shared) != napi_ok) {
    napi_throw_type_error(env, NULL, "expected a file descriptor and shared flag");
    return NULL;
  }
  int rc;
  do { rc = flock(fd, (shared ? LOCK_SH : LOCK_EX) | LOCK_NB); } while (rc < 0 && errno == EINTR);
  if (rc < 0) {
    const int failure = errno;
    napi_throw_error(env, failure == EWOULDBLOCK ? "EWOULDBLOCK" : uv_err_name(uv_translate_sys_error(failure)), strerror(failure));
    return NULL;
  }
  napi_get_undefined(env, &result);
  return result;
}

/* Resolve exactly one component beneath a pinned directory descriptor.
 * No component can redirect a managed artifact capture through a symlink. */
static napi_value open_child(napi_env env, napi_callback_info info) {
  size_t argc = 3, length = 0;
  napi_value argv[3], result;
  int32_t parent;
  bool directory;
  char name[NAME_MAX + 1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3 ||
      napi_get_value_int32(env, argv[0], &parent) != napi_ok || parent < 0 ||
      napi_get_value_string_utf8(env, argv[1], NULL, 0, &length) != napi_ok ||
      !length || length > NAME_MAX || napi_get_value_bool(env, argv[2], &directory) != napi_ok ||
      napi_get_value_string_utf8(env, argv[1], name, sizeof(name), NULL) != napi_ok ||
      strlen(name) != length || strchr(name, '/') || !strcmp(name, ".") || !strcmp(name, "..")) {
    napi_throw_type_error(env, NULL, "expected a directory descriptor, child name and directory flag");
    return NULL;
  }
  int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | O_NOCTTY;
  if (directory) flags |= O_DIRECTORY;
  struct stat st;
  int failure = 0, fd = -1;
#if defined(__linux__)
  // Pin and classify the inode without opening a device driver. Reopen a
  // proven regular file through the pinned descriptor, never its input path.
  fd = openat(parent, name, directory ? flags : O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) failure = errno;
  else if (fstat(fd, &st) != 0) failure = errno;
  else if (!directory && (!S_ISREG(st.st_mode) || st.st_nlink != 1)) failure = EINVAL;
  else if (!directory) {
    char path[64];
    snprintf(path,sizeof(path),"/proc/self/fd/%d",fd);
    int reader = open(path,O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOCTTY);
    if (reader < 0) failure = errno;
    close(fd);
    fd = reader;
  }
#else
  if (fstatat(parent,name,&st,AT_SYMLINK_NOFOLLOW) != 0) failure = errno;
  else if (directory ? !S_ISDIR(st.st_mode) : (!S_ISREG(st.st_mode) || st.st_nlink != 1)) failure = EINVAL;
  else {
    fd = openat(parent,name,flags);
    struct stat opened;
    if (fd < 0) failure = errno;
    else if (fstat(fd,&opened) != 0) failure = errno;
    else if (opened.st_dev != st.st_dev || opened.st_ino != st.st_ino ||
             (!directory && (!S_ISREG(opened.st_mode) || opened.st_nlink != 1))) failure = EINVAL;
  }
#endif
  if (failure) {
    if (fd >= 0) close(fd);
    napi_throw_error(env, uv_err_name(uv_translate_sys_error(failure)), strerror(failure));
    return NULL;
  }
  if (napi_create_int32(env, fd, &result) != napi_ok) { close(fd); return NULL; }
  return result;
}

napi_status register_host_process(napi_env env, napi_value exports);


static napi_value init(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "peerUid", NAPI_AUTO_LENGTH, peer_uid, NULL,
                           &function) != napi_ok ||
      napi_set_named_property(env, exports, "peerUid", function) != napi_ok)
    return NULL;
  if (napi_create_function(env, "tryLock", NAPI_AUTO_LENGTH, try_lock, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "tryLock", function) != napi_ok) return NULL;
  if (napi_create_function(env, "openChild", NAPI_AUTO_LENGTH, open_child, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "openChild", function) != napi_ok) return NULL;
  if (register_host_process(env, exports) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
