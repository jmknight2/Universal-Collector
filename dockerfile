# Use a tiny Alpine Linux image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package config and install dependencies
COPY package.json .
RUN npm install

# Copy the rest of the app source
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Define the command to run your app
CMD ["node", "server.js"]