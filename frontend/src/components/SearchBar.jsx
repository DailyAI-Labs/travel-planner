import React, { useState } from "react";

const SearchBar = ({ addLocation }) => {
  const [searchQuery, setSearchQuery] = useState("");

  const handleAddLocation = () => {
    if (searchQuery.trim() !== "") {
      // Replace this with Google Places API call to get the coordinates
      const dummyLocation = {
        name: searchQuery,
        lat: 40.7128 + Math.random() * 0.1, // Mock latitude
        lng: -74.006 + Math.random() * 0.1, // Mock longitude
      };
      addLocation(dummyLocation);
      setSearchQuery("");
    }
  };

  return (
    <div className="search-bar">
      <input
        type="text"
        placeholder="Search for a place..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />
      <button onClick={handleAddLocation}>Add</button>
    </div>
  );
};

export default SearchBar;
