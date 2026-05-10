FROM node:lts-alpine3.23

# Arguments
ARG APP_HOME=/home/node/app

# Install system dependencies
# "Don't rely on the base image for tools; if you call it, you install it." ;)
RUN apk add --no-cache gcompat tini git git-lfs su-exec shadow dos2unix

# Create app directory and set ownership
WORKDIR ${APP_HOME}
RUN chown node:node ${APP_HOME}

# Set NODE_ENV to production
ENV NODE_ENV=production

# Bundle app source and set ownership
COPY --chown=node:node . ./

RUN \
  echo "*** Install npm packages ***" && \
  npm ci --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts && npm cache clean --force

# Create config directory and link config.yaml. Added hardcoded dirs(constants.js?)
# that must be present for Non-Root Mode and volumeless docker runs.
RUN \
  rm -f "config.yaml" || true && \
  mkdir -p config data plugins public/scripts/extensions/third-party backups && \
  chown -R node:node config data plugins public/scripts/extensions/third-party backups && \
  ln -s "./config/config.yaml" "config.yaml"

# Pre-compile public libraries
RUN \
  echo "*** Run Webpack ***" && \
  node "./docker/build-lib.js"

# Stage the entrypoint script.
#
# Some build hosts (ZFS / NFS / certain overlay stacks) refuse to `mv` or
# `rm -rf` directories that came in via COPY with EINVAL on Alpine's
# busybox. We sidestep both: copy the file out with `cp` and leave the
# `./docker/` directory in place — its contents are harmless inside the
# image, and trying to remove it crashes the build on those hosts.
RUN \
  echo "*** Stage entrypoint ***" && \
  cp "./docker/docker-entrypoint.sh" "./docker-entrypoint.sh" && \
  chmod +x "./docker-entrypoint.sh" && \
  dos2unix "./docker-entrypoint.sh"

# Fix extension repos permissions
RUN git config --global --add safe.directory "*"

EXPOSE 8000

# Ensure proper handling of kernel signals
ENTRYPOINT ["tini", "--", "./docker-entrypoint.sh"]
