FROM node AS dev

RUN apt install -y git
RUN npm install -g npm@11.12.1 husky
RUN git config --global --add safe.directory /parallel