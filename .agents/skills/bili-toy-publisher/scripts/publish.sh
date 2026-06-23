#!/usr/bin/env bash

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DOCTOR="$SCRIPT_DIR/toy_doctor.py"

API_MODE="${TOY_API_MODE:-auto}"
INTERNAL_API_BASE_URL="${TOY_INTERNAL_API_BASE_URL:-${TOY_API_BASE_URL:-https://sunflower.bilibili.co}}"
INTERNAL_API_PATH="${TOY_INTERNAL_API_PATH:-${TOY_API_PATH:-/api/toy}}"
PUBLIC_API_BASE_URL="${TOY_PUBLIC_API_BASE_URL:-https://api.bilibili.com}"
PUBLIC_API_PATH="${TOY_PUBLIC_API_PATH:-/x/sunflower/artifex/toy}"
COOKIE_FILE="${TOY_COOKIE_FILE:-${HOME:-}/.bilibili_cookie}"
CURL_CONNECT_TIMEOUT="${TOY_CURL_CONNECT_TIMEOUT:-10}"
CURL_MAX_TIME="${TOY_CURL_MAX_TIME:-120}"

DIR="${TOY_DIR:-}"
TITLE="${TOY_TITLE:-}"
SLUG="${TOY_SLUG:-}"
POSTER="${TOY_POSTER:-}"
ID="${TOY_ID:-}"
UID_VAL="${TOY_UID:-auto}"
COMMAND=""

show_help() {
  cat << EOF

Bilibili TOY publisher

Usage:
  publish.sh <command> [options]

Commands:
  preview   Upload a static directory and print a preview URL
  create    Create a new TOY project
  update    Update an existing TOY project

Options:
  --dir <path>       Static directory containing root index.html
  --title <string>   TOY title
  --slug <slug>      URL path for create
  --poster <path>    Cover image (.png, .jpg, .jpeg)
  --id <number>      Project ID for update
  --uid <number|auto>
                     Publishing UID. Default: auto from Cookie DedeUserID.

Environment:
  TOY_DIR, TOY_TITLE, TOY_SLUG, TOY_POSTER, TOY_ID, TOY_UID
  TOY_COOKIE_FILE
  TOY_API_MODE             auto (default), public, or internal
  TOY_PUBLIC_API_BASE_URL, TOY_PUBLIC_API_PATH
  TOY_INTERNAL_API_BASE_URL, TOY_INTERNAL_API_PATH
  TOY_API_BASE_URL, TOY_API_PATH  legacy aliases for internal API
  TOY_CURL_CONNECT_TIMEOUT, TOY_CURL_MAX_TIME

Examples:
  publish.sh preview --dir ./dist --uid auto
  publish.sh create --dir ./dist --title "My TOY" --slug my-toy --poster ./assets/cover.png --uid auto
  publish.sh update --id 123 --dir ./dist --title "My TOY" --uid auto

EOF
}

error() {
  printf '\n%bERROR:%b %b\n' "$RED" "$NC" "$1" >&2
  exit 1
}

warn() {
  printf '%bWARN:%b %b\n' "$YELLOW" "$NC" "$1" >&2
}

info() {
  printf '%b%b%b\n' "$BLUE" "$1" "$NC"
}

success() {
  printf '%b%b%b\n' "$GREEN" "$1" "$NC"
}

require_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || error "$option requires a value"
}

absolute_path() {
  local path="$1"
  local dir
  local base

  case "$path" in
    /*) printf '%s\n' "$path" ;;
    *)
      dir="$(dirname "$path")"
      base="$(basename "$path")"
      printf '%s/%s\n' "$(cd "$dir" && pwd -P)" "$base"
      ;;
  esac
}

check_dependencies() {
  command -v zip >/dev/null 2>&1 || error "missing dependency: zip"
  command -v curl >/dev/null 2>&1 || error "missing dependency: curl"
  command -v python3 >/dev/null 2>&1 || error "missing dependency: python3"
  [[ -x "$DOCTOR" || -f "$DOCTOR" ]] || error "missing bundled doctor: $DOCTOR"
}

get_cookie() {
  if [[ -n "$COOKIE_FILE" && -f "$COOKIE_FILE" ]]; then
    tr -d '\r\n' < "$COOKIE_FILE"
  fi
}

cookie_value() {
  local key="$1"
  local cookie="$2"
  local entry
  local name
  local value
  local -a entries

  IFS=';' read -r -a entries <<< "$cookie"
  for entry in "${entries[@]}"; do
    entry="${entry#"${entry%%[![:space:]]*}"}"
    [[ "$entry" == *=* ]] || continue
    name="${entry%%=*}"
    value="${entry#*=}"
    if [[ "$name" == "$key" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  done
}

resolve_api_mode() {
  case "$API_MODE" in
    auto|public)
      printf 'public\n'
      ;;
    internal)
      printf 'internal\n'
      ;;
    *)
      error "TOY_API_MODE must be auto, public, or internal: $API_MODE"
      ;;
  esac
}

api_base_url() {
  case "$1" in
    public) printf '%s\n' "$PUBLIC_API_BASE_URL" ;;
    internal) printf '%s\n' "$INTERNAL_API_BASE_URL" ;;
    *) error "unknown API mode: $1" ;;
  esac
}

api_path() {
  case "$1" in
    public) printf '%s\n' "$PUBLIC_API_PATH" ;;
    internal) printf '%s\n' "$INTERNAL_API_PATH" ;;
    *) error "unknown API mode: $1" ;;
  esac
}

csrf_token() {
  local cookie="$1"
  local csrf

  csrf="$(cookie_value "bili_jct" "$cookie")"
  [[ -n "$csrf" ]] || error "cookie does not contain bili_jct; public TOY API requires CSRF"
  printf '%s\n' "$csrf"
}

check_cookie_and_uid() {
  if [[ -z "$COOKIE_FILE" || ! -f "$COOKIE_FILE" ]]; then
    warn "cookie file not found: $COOKIE_FILE"
    exit 170
  fi

  chmod 600 "$COOKIE_FILE" 2>/dev/null || warn "could not chmod 600 cookie file: $COOKIE_FILE"

  local cookie
  local cookie_uid
  cookie="$(get_cookie)"
  if [[ -z "$cookie" ]]; then
    warn "cookie file is empty: $COOKIE_FILE"
    exit 170
  fi

  cookie_uid="$(cookie_value "DedeUserID" "$cookie")"
  if [[ -z "$cookie_uid" ]]; then
    error "cookie does not contain DedeUserID; cannot safely determine Bilibili account UID"
  fi
  if ! [[ "$cookie_uid" =~ ^[0-9]+$ ]]; then
    error "cookie DedeUserID is not numeric: $cookie_uid"
  fi

  if [[ -z "$UID_VAL" || "$UID_VAL" == "auto" ]]; then
    UID_VAL="$cookie_uid"
  elif [[ "$UID_VAL" != "$cookie_uid" ]]; then
    error "UID mismatch: --uid=${UID_VAL}, Cookie DedeUserID=${cookie_uid}. Use DedeUserID or refresh cookie."
  fi

  info "Identity check: DedeUserID=$cookie_uid"
}

validate_id() {
  [[ "$1" =~ ^[0-9]+$ ]] || error "project ID must be numeric: $1"
}

validate_slug() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || error "slug must contain only letters, numbers, and hyphens: $1"
}

validate_uid_arg() {
  [[ "$1" == "auto" || "$1" =~ ^[0-9]+$ ]] || error "UID must be numeric or auto: $1"
}

validate_poster() {
  local poster="$1"
  [[ -f "$poster" ]] || error "poster file does not exist: $poster"
  case "$poster" in
    *.png|*.PNG|*.jpg|*.JPG|*.jpeg|*.JPEG) ;;
    *) error "official poster formats are png, jpg, jpeg: $poster" ;;
  esac
}

validate_dir_if_present() {
  if [[ -n "$DIR" ]]; then
    [[ -d "$DIR" ]] || error "static directory does not exist: $DIR"
    [[ -f "$DIR/index.html" ]] || error "static directory must contain root index.html: $DIR"
  fi
}

parse_args() {
  if [[ $# -eq 0 ]]; then
    show_help
    exit 0
  fi

  COMMAND="$1"
  shift
  case "$COMMAND" in
    preview|create|update) ;;
    --help|-h)
      show_help
      exit 0
      ;;
    *) error "unknown command: $COMMAND" ;;
  esac

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)
        show_help
        exit 0
        ;;
      --dir)
        require_value "$1" "${2:-}"
        DIR="$2"
        shift 2
        ;;
      --title)
        require_value "$1" "${2:-}"
        TITLE="$2"
        shift 2
        ;;
      --slug)
        require_value "$1" "${2:-}"
        SLUG="$2"
        shift 2
        ;;
      --poster)
        require_value "$1" "${2:-}"
        POSTER="$2"
        shift 2
        ;;
      --id)
        require_value "$1" "${2:-}"
        ID="$2"
        shift 2
        ;;
      --uid)
        require_value "$1" "${2:-}"
        UID_VAL="$2"
        shift 2
        ;;
      *)
        error "unknown option: $1"
        ;;
    esac
  done
}

validate_params() {
  case "$COMMAND" in
    preview)
      [[ -n "$DIR" ]] || error "preview requires --dir"
      ;;
    create)
      [[ -n "$DIR" ]] || error "create requires --dir"
      [[ -n "$TITLE" ]] || error "create requires --title"
      [[ -n "$SLUG" ]] || error "create requires --slug"
      [[ -n "$POSTER" ]] || error "create requires --poster"
      ;;
    update)
      [[ -n "$ID" ]] || error "update requires --id"
      if [[ -z "$DIR" && -z "$TITLE" && -z "$POSTER" ]]; then
        error "update requires at least one of --dir, --title, --poster"
      fi
      ;;
  esac

  validate_uid_arg "$UID_VAL"
  validate_dir_if_present
  [[ -z "$ID" ]] || validate_id "$ID"
  [[ -z "$SLUG" ]] || validate_slug "$SLUG"
  [[ -z "$POSTER" ]] || validate_poster "$POSTER"
}

run_doctor() {
  [[ -n "$DIR" ]] || return 0

  local args=("$DOCTOR" "$DIR" "--require-root-index")
  [[ -z "$SLUG" ]] || args+=("--slug" "$SLUG")
  [[ -z "$POSTER" ]] || args+=("--poster" "$POSTER")
  [[ "$COMMAND" != "create" ]] || args+=("--require-poster")

  info "Running TOY static checks..."
  python3 "${args[@]}"
  echo ""
}

create_zip() {
  local dir="$1"
  local zip_file="$2"
  local size

  run_doctor

  info "Packaging static directory..."
  (
    cd "$dir"
    zip -r -q "$zip_file" . \
      -x "*.DS_Store" "__MACOSX/*" "*/__MACOSX/*" \
      -x ".*" "*/.*" \
      -x "toy.yaml" "*/toy.yaml" \
      -x "node_modules/*" "*/node_modules/*"
  )

  [[ -f "$zip_file" ]] || error "failed to create ZIP"
  size="$(du -h "$zip_file" | cut -f1)"
  success "Package ready ($size)"
  echo ""
}

post_form() {
  local mode="$1"
  local url="$2"
  shift 2

  local body_file
  local err_file
  local http_status
  local response
  local curl_error
  local cookie
  local csrf
  local full_url
  local -a curl_args

  body_file="$(mktemp)"
  err_file="$(mktemp)"
  cookie="$(get_cookie)"
  full_url="$url"

  curl_args=(curl -sS --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" -X POST)
  curl_args+=(-H "Cookie: $cookie")
  if [[ "$mode" == "public" ]]; then
    csrf="$(csrf_token "$cookie")"
    curl_args+=(-H "Referer: https://www.bilibili.com/toy/publish")
    curl_args+=(-H "Origin: https://www.bilibili.com")
    curl_args+=(-F "csrf=$csrf")
  else
    full_url="${url}?uid=${UID_VAL}"
  fi
  curl_args+=("$@" -o "$body_file" -w "%{http_code}" "$full_url")

  if ! http_status="$("${curl_args[@]}" 2>"$err_file")"; then
    curl_error="$(cat "$err_file")"
    rm -f "$body_file" "$err_file"
    error "request failed: ${curl_error:-curl execution failed}"
  fi

  response="$(cat "$body_file")"
  curl_error="$(cat "$err_file")"
  rm -f "$body_file" "$err_file"

  if ! [[ "$http_status" =~ ^[0-9][0-9][0-9]$ ]]; then
    error "request failed: invalid HTTP status (${http_status:-empty})"
  fi
  if [[ "$http_status" != 2* ]]; then
    error "HTTP request failed ($http_status): ${response:-$curl_error}"
  fi

  printf '%s' "$response"
}

json_from_jq() {
  local json="$1"
  local filter="$2"

  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r "$filter" 2>/dev/null | sed '/^null$/d' | sed '/^$/d' | head -1 || true
  fi
}

json_number() {
  local json="$1"
  local key="$2"
  local value

  value="$(json_from_jq "$json" "[.. | objects | .$key? | select(type == \"number\" or type == \"string\")][0] // empty")"
  if [[ -n "$value" ]]; then
    printf '%s\n' "$value"
    return 0
  fi

  printf '%s' "$json" | tr '\n' ' ' | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\\(-\\{0,1\\}[0-9][0-9]*\\).*/\\1/p" | head -1
}

json_string() {
  local json="$1"
  local key="$2"
  local value

  value="$(json_from_jq "$json" "[.. | objects | .$key? | select(type == \"string\")][0] // empty")"
  if [[ -n "$value" ]]; then
    printf '%s\n' "$value"
    return 0
  fi

  printf '%s' "$json" | tr '\n' ' ' | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -1
}

ensure_api_success() {
  local action="$1"
  local response="$2"
  local code
  local message

  code="$(json_number "$response" code)"
  if [[ "$code" == "0" ]]; then
    return 0
  fi
  if [[ "$code" == "-101" || "$code" == "-401" ]]; then
    warn "login state expired or unauthorized"
    exit 171
  fi

  message="$(json_string "$response" message)"
  [[ -n "$message" ]] || message="$(json_string "$response" msg)"
  [[ -n "$code" ]] || code="unknown"
  error "$action failed: ${message:-unknown error} (code: $code)"
}

preview_project() {
  local dir="$1"
  local api_mode
  local tmp_dir
  local zip_file
  local response
  local preview_url
  local url

  info "Previewing project..."
  info "Static directory: $(cd "$dir" && pwd -P)"
  echo ""

  tmp_dir="$(mktemp -d)"
  zip_file="$tmp_dir/project.zip"
  create_zip "$dir" "$zip_file"

  api_mode="$(resolve_api_mode)"
  url="$(api_base_url "$api_mode")$(api_path "$api_mode")/preview"
  info "API mode: $api_mode"
  info "Uploading preview: $url"
  response="$(post_form "$api_mode" "$url" -F "file=@$zip_file;type=application/zip")"
  rm -rf "$tmp_dir"

  ensure_api_success "preview" "$response"

  preview_url="$(json_string "$response" url)"
  [[ -n "$preview_url" ]] || error "preview succeeded but no URL was returned"

  success "Preview generated"
  info "Preview URL: $preview_url"
}

publish_project() {
  local api_mode
  local tmp_dir=""
  local zip_file=""
  local poster_file=""
  local endpoint
  local url
  local response
  local result_url
  local result_id
  local action
  local -a form_args

  if [[ "$COMMAND" == "create" ]]; then
    action="create"
  else
    action="update"
  fi

  info "Starting $action..."
  [[ -n "$DIR" ]] && info "Static directory: $(cd "$DIR" && pwd -P)"
  [[ -n "$TITLE" ]] && info "Title: $TITLE"
  [[ "$COMMAND" == "create" && -n "$SLUG" ]] && info "Slug: $SLUG"
  [[ "$COMMAND" == "update" && -n "$ID" ]] && info "Project ID: $ID"
  echo ""

  if [[ -n "$DIR" ]]; then
    tmp_dir="$(mktemp -d)"
    zip_file="$tmp_dir/project.zip"
    create_zip "$DIR" "$zip_file"
  fi

  if [[ -n "$POSTER" ]]; then
    poster_file="$(absolute_path "$POSTER")"
    info "Poster: $poster_file"
  fi

  if [[ "$COMMAND" == "create" ]]; then
    endpoint="/create"
  else
    endpoint="/update"
  fi

  api_mode="$(resolve_api_mode)"
  url="$(api_base_url "$api_mode")$(api_path "$api_mode")${endpoint}"
  form_args=()
  if [[ "$COMMAND" == "update" ]]; then
    form_args+=(-F "id=$ID")
    [[ -z "$TITLE" ]] || form_args+=(-F "title=$TITLE")
    [[ -z "$zip_file" ]] || form_args+=(-F "file=@$zip_file;type=application/zip")
    [[ -z "$poster_file" ]] || form_args+=(-F "poster=@$poster_file")
  else
    form_args+=(-F "title=$TITLE")
    form_args+=(-F "sub_dir=$SLUG")
    form_args+=(-F "file=@$zip_file;type=application/zip")
    form_args+=(-F "poster=@$poster_file")
  fi

  info "API mode: $api_mode"
  info "Submitting $action: $url"
  response="$(post_form "$api_mode" "$url" "${form_args[@]}")"
  [[ -z "$tmp_dir" ]] || rm -rf "$tmp_dir"

  ensure_api_success "$action" "$response"

  success "$action succeeded"
  result_url="$(json_string "$response" url)"
  result_id="$(json_number "$response" id)"

  [[ -z "$result_url" ]] || info "URL: $result_url"
  [[ -z "$result_id" ]] || info "Project ID: $result_id"
}

main() {
  parse_args "$@"
  check_dependencies
  validate_params
  check_cookie_and_uid

  if [[ "$COMMAND" == "preview" ]]; then
    preview_project "$DIR"
  else
    publish_project
  fi
}

main "$@"
